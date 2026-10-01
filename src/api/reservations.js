import { Router } from "express";
import db, { getConfig } from "../db/database.js";
import { getMailSettings, isNotifyEmailConfigured, isSmtpConfigured, sendMail } from "../mail/mailer.js";
import { requireAuth } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { resolveB2bAccount, b2bPricing, b2bUnitPriceCents, vatCents, B2B_VAT_RATE } from "./b2b.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { formatIban } from "../utils/iban.js";

const router = Router();

// Public checkout endpoint: cap volume to blunt spam/DB-flooding.
const reservationLimiter = rateLimit({ windowMs: 60 * 1000, max: 10 });

// awaiting_payment: a transfer reservation, until the admin sees the money
// arrive and confirms it. Not a sale yet, so "Lo más vendido" ignores it
// (SOLD_STATUSES in site/_data/shopBlocks.js).
const VALID_STATUSES = ["awaiting_payment", "pending", "confirmed", "ready_for_pickup", "completed", "cancelled"];

const eur = (cents) => `${(cents / 100).toFixed(2)} €`;

// How the customer pays, shown on the checkout screen and in their email.
// A B2B account pays the way it has agreed with the business, so it never
// sees the IBAN. A retail customer pays by transfer when the panel has bank
// details; with none set, null keeps the original reserve-and-pay-on-delivery.
// Called before the insert, since it also decides the starting status; the
// reference (the reservation number) is filled in once the row exists.
function paymentInstructions({ amountCents, b2b }) {
  if (b2b) return { method: "usual" };
  const iban = getConfig("bank_iban");
  if (!iban) return null;
  return {
    method: "transfer",
    holder: getConfig("bank_holder") || getConfig("legal_name") || getConfig("company_name") || "",
    iban: formatIban(iban),
    bic: (getConfig("bank_bic") || "").toUpperCase(),
    reference: null,
    amount_cents: amountCents,
  };
}

function paymentText(payment) {
  if (!payment) return "Te avisaremos para confirmar la entrega.";
  if (payment.method === "usual") {
    return "El pago se hará según tu forma de pago habitual con nosotros. Te avisaremos para confirmar la entrega.";
  }
  const lines = [`Para completar tu reserva, haz una transferencia de ${eur(payment.amount_cents)} a:`];
  if (payment.holder) lines.push(`Titular: ${payment.holder}`);
  lines.push(`IBAN: ${payment.iban}`);
  if (payment.bic) lines.push(`BIC: ${payment.bic}`);
  lines.push(`Concepto: ${payment.reference}`, "", "Prepararemos tu pedido en cuanto recibamos el pago.");
  return lines.join("\n");
}

// GET /api/reservations — panel list (newest first)
router.get("/", requireAuth, (req, res) => {
  const reservations = db
    .prepare("SELECT * FROM reservations ORDER BY datetime(created_at) DESC, id DESC")
    .all();
  res.json({ reservations });
});

// GET /api/reservations/:id — panel detail, with items
router.get("/:id", requireAuth, (req, res) => {
  const reservation = db.prepare("SELECT * FROM reservations WHERE id = ?").get(req.params.id);
  if (!reservation) return res.status(404).json({ error: "Reserva no encontrada" });
  const items = db
    .prepare("SELECT * FROM reservation_items WHERE reservation_id = ?")
    .all(req.params.id);
  res.json({ ...reservation, items });
});

// POST /api/reservations — public checkout submission
router.post("/", reservationLimiter, asyncHandler(async (req, res) => {
  const customer_name = typeof req.body.customer_name === "string" ? req.body.customer_name.trim() : "";
  const customer_email = typeof req.body.customer_email === "string" ? req.body.customer_email.trim() : "";
  const customer_phone = typeof req.body.customer_phone === "string" ? req.body.customer_phone.trim() : "";
  const notes = typeof req.body.notes === "string" ? req.body.notes.trim() : "";
  const items = Array.isArray(req.body.items) ? req.body.items : [];

  if (!customer_name || !customer_email || items.length === 0) {
    return res
      .status(400)
      .json({ error: "customer_name, customer_email y al menos un producto son obligatorios" });
  }

  // Recompute totals server-side from the current catalog — never trust
  // client-sent prices. A signed-in B2B account is priced at its trade price
  // here, from its session cookie; the cart's own figures are display only.
  // Trade prices exclude VAT: unit prices and total_cents are then net, and
  // the VAT is recorded on its own in vat_cents.
  const b2bAccount = resolveB2bAccount(req);
  const pricing = b2bAccount ? b2bPricing() : null;
  const resolvedItems = [];
  for (const item of items) {
    const product = db.prepare("SELECT * FROM products WHERE sku = ? AND active = 1").get(item.sku);
    if (!product) {
      return res.status(400).json({ error: `Producto no disponible: ${item.sku}` });
    }
    const quantity = parseInt(item.quantity, 10);
    if (!Number.isFinite(quantity) || quantity < 1) {
      return res.status(400).json({ error: `Cantidad inválida para ${item.sku}` });
    }
    resolvedItems.push({
      sku: product.sku,
      product_name: product.name,
      unit_price_cents: pricing ? b2bUnitPriceCents(product, pricing) : product.price_cents,
      quantity,
    });
  }
  const total_cents = resolvedItems.reduce((sum, i) => sum + i.unit_price_cents * i.quantity, 0);
  const vat_included = b2bAccount ? 0 : 1;
  const vat_cents = b2bAccount ? vatCents(total_cents) : null;
  const payment = paymentInstructions({
    amountCents: vat_included ? total_cents : total_cents + vat_cents,
    b2b: Boolean(b2bAccount),
  });
  const status = payment?.method === "transfer" ? "awaiting_payment" : "pending";

  const insertReservation = db.transaction(() => {
    const result = db
      .prepare(
        "INSERT INTO reservations (customer_name, customer_email, customer_phone, notes, status, total_cents, b2b_account_id, b2b_company, vat_included, vat_cents) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        customer_name,
        customer_email,
        customer_phone,
        notes,
        status,
        total_cents,
        b2bAccount ? b2bAccount.id : null,
        b2bAccount ? b2bAccount.company_name : null,
        vat_included,
        vat_cents,
      );
    const insertItem = db.prepare(
      "INSERT INTO reservation_items (reservation_id, sku, product_name, unit_price_cents, quantity) VALUES (?, ?, ?, ?, ?)",
    );
    for (const item of resolvedItems) {
      insertItem.run(result.lastInsertRowid, item.sku, item.product_name, item.unit_price_cents, item.quantity);
    }
    return result.lastInsertRowid;
  });

  const reservationId = insertReservation();

  if (payment?.method === "transfer") payment.reference = `Reserva ${reservationId}`;

  const itemsList = resolvedItems
    .map((i) => `- ${i.quantity} x ${i.product_name} (${eur(i.unit_price_cents)}${vat_included ? "" : " sin IVA"})`)
    .join("\n");
  const totals = vat_included
    ? `Total: ${eur(total_cents)}`
    : `Total sin IVA: ${eur(total_cents)}\nIVA (${Math.round(B2B_VAT_RATE * 100)} %): ${eur(vat_cents)}\nTotal con IVA: ${eur(total_cents + vat_cents)}`;
  const settings = getMailSettings();

  // Owner notification and customer copy go out together, not one after the
  // other: the checkout waits for both, and SMTP can take seconds each.
  const notifyOwner = async () => {
    if (!isSmtpConfigured(settings) || !isNotifyEmailConfigured(settings)) return;
    try {
      const b2bLine = b2bAccount
        ? `Cuenta de empresa: ${b2bAccount.company_name}${b2bAccount.tax_id ? ` (${b2bAccount.tax_id})` : ""} — precios profesionales aplicados\n`
        : "";
      const paymentLine = payment?.method === "transfer"
        ? `Pago: por transferencia, concepto «${payment.reference}»\n`
        : payment?.method === "usual"
          ? "Pago: forma de pago habitual de la empresa\n"
          : "";
      await sendMail(
        {
          from: `"${customer_name}" <${settings.user}>`,
          to: settings.notifyEmail,
          subject: `Nueva reserva #${reservationId}${b2bAccount ? ` (empresa: ${b2bAccount.company_name})` : ""}`,
          text: `${b2bLine}${paymentLine}Cliente: ${customer_name}\nEmail: ${customer_email}\nTeléfono: ${customer_phone}\n\nProductos:\n${itemsList}\n\n${totals}\n\nNotas: ${notes}`,
        },
        settings,
      );
    } catch (err) {
      console.error("Error enviando email de notificación de reserva:", err.message);
    }
  };

  // The customer's own copy, with how to pay. Needs only SMTP, not
  // notify_email (that is the owner's address). Swallowed like the one above:
  // the reservation is stored and the screen already shows the same details.
  const notifyCustomer = async () => {
    if (!isSmtpConfigured(settings)) return;
    try {
      const companyName = getConfig("company_name") || "Web";
      await sendMail(
        {
          from: `"${companyName}" <${settings.user}>`,
          to: customer_email,
          subject: `Tu reserva nº ${reservationId} — ${companyName}`,
          text: `Hola ${customer_name},\n\nHemos recibido tu reserva nº ${reservationId}.\n\nProductos:\n${itemsList}\n\n${totals}\n\n${paymentText(payment)}\n\n— ${companyName}`,
        },
        settings,
      );
    } catch (err) {
      console.error("Error enviando la confirmación de reserva al cliente:", err.message);
    }
  };

  await Promise.all([notifyOwner(), notifyCustomer()]);

  res.status(201).json({
    success: true,
    id: reservationId,
    total_cents,
    vat_included: Boolean(vat_included),
    vat_cents,
    b2b: Boolean(b2bAccount),
    payment,
  });
}));

router.put("/:id", requireAuth, (req, res) => {
  const { status } = req.body;
  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: "Estado no válido" });
  }
  const result = db
    .prepare("UPDATE reservations SET status = ?, updated_at = datetime('now') WHERE id = ?")
    .run(status, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: "Reserva no encontrada" });
  res.json({
    success: true,
    ...db.prepare("SELECT * FROM reservations WHERE id = ?").get(req.params.id),
  });
});

export default router;
