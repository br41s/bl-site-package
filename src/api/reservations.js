import { Router } from "express";
import db, { getConfig } from "../db/database.js";
import { describeReservation, sendReservationMails } from "../mail/reservation-mails.js";
import { createMoneiPayment, isMoneiConfigured } from "./monei.js";
import { requireAuth } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { resolveB2bAccount, b2bPricing, b2bUnitPriceCents, vatCentsByRate, B2B_VAT_RATE } from "./b2b.js";
import { parseShippingZones } from "../shipping.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { formatIban } from "../utils/iban.js";

const router = Router();

// Public checkout endpoint: cap volume to blunt spam/DB-flooding.
const reservationLimiter = rateLimit({ windowMs: 60 * 1000, max: 10 });

// awaiting_payment: a transfer reservation, until the admin sees the money
// arrive and confirms it. Not a sale yet, so "Lo más vendido" ignores it
// (SOLD_STATUSES in site/_data/shopBlocks.js).
const VALID_STATUSES = ["awaiting_payment", "pending", "confirmed", "ready_for_pickup", "completed", "cancelled"];

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

// GET /api/reservations — panel list (newest first)
router.get("/", requireAuth, (req, res) => {
  const reservations = db
    .prepare("SELECT * FROM reservations ORDER BY datetime(created_at) DESC, id DESC")
    .all();
  res.json({ reservations });
});

// GET /api/reservations/payment-options — public. What the cart can offer, so
// the page shows a card option only when MONEI is set up and a transfer option
// only when there are bank details. Nothing here is a secret.
router.get("/payment-options", (req, res) => {
  res.json({ card: isMoneiConfigured(), transfer: Boolean(getConfig("bank_iban")) });
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
  // A distance sale needs the buyer to have accepted the terms before ordering
  // (LSSI-CE art. 27); the checkbox is in site/carrito.njk and the time it was
  // ticked is kept with the order as the record of it. A page cached from
  // before the checkbox existed sends nothing, hence the hint to reload.
  if (req.body.accept_terms !== true) {
    return res.status(400).json({
      error: "Debes aceptar las condiciones de venta y la política de privacidad (si no ves la casilla, recarga la página).",
    });
  }

  // Recompute totals server-side from the current catalog — never trust
  // client-sent prices. A signed-in B2B account is priced at its trade price
  // here, from its session cookie; the cart's own figures are display only.
  // Trade prices exclude VAT: unit prices and total_cents are then net, and
  // the VAT — at each product's own rate — is recorded on its own in vat_cents.
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
      vat_rate: product.vat_rate,
    });
  }
  // Shipping: with zones configured the buyer must pick one we deliver to, and
  // its price is added here, from config — the cart's figure is display only.
  // "Otros destinos" (or anything unknown) is refused: the business does not
  // ship there. The zone price includes VAT; a B2B order takes it off like any
  // other trade price and carries it in vat_cents at the default rate.
  const zones = parseShippingZones(getConfig("shipping_zones"));
  let zone = null;
  if (zones.length > 0) {
    zone = zones.find((z) => z.id === req.body.shipping_zone);
    if (!zone) {
      return res.status(400).json({
        error:
          req.body.shipping_zone === "otros"
            ? "No realizamos envíos a ese destino."
            : "Elige una zona de envío (si no ves el selector, recarga la página).",
      });
    }
  }
  const shipping_cents = zone ? (b2bAccount ? Math.round(zone.price_cents / (1 + B2B_VAT_RATE)) : zone.price_cents) : null;
  const total_cents =
    resolvedItems.reduce((sum, i) => sum + i.unit_price_cents * i.quantity, 0) + (shipping_cents || 0);
  const vat_included = b2bAccount ? 0 : 1;
  const vat_cents = b2bAccount
    ? vatCentsByRate([
        ...resolvedItems.map((i) => ({ netCents: i.unit_price_cents * i.quantity, vatRate: i.vat_rate })),
        ...(shipping_cents ? [{ netCents: shipping_cents, vatRate: B2B_VAT_RATE }] : []),
      ])
    : null;
  // Card is only used when the page asks for it (payment_method: "card"): a page
  // cached from before this existed sends nothing and gets the old behaviour,
  // instead of a reservation waiting for a payment its customer was never sent to.
  // Card is for retail only; a B2B account keeps paying the way it has agreed.
  const wantsCard = req.body.payment_method === "card";
  if (wantsCard && (b2bAccount || !isMoneiConfigured())) {
    return res.status(400).json({ error: "El pago con tarjeta no está disponible. Recarga la página." });
  }
  const payment = wantsCard
    ? { method: "card", amount_cents: total_cents }
    : paymentInstructions({
        amountCents: vat_included ? total_cents : total_cents + vat_cents,
        b2b: Boolean(b2bAccount),
      });
  const status = payment?.method === "transfer" || wantsCard ? "awaiting_payment" : "pending";

  const insertReservation = db.transaction(() => {
    const result = db
      .prepare(
        "INSERT INTO reservations (customer_name, customer_email, customer_phone, notes, status, total_cents, b2b_account_id, b2b_company, vat_included, vat_cents, shipping_zone, shipping_cents, terms_accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))",
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
        zone ? zone.label : null,
        shipping_cents,
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

  // A card order is created unpaid, then handed to MONEI's payment page. The
  // emails wait for MONEI's callback (src/api/monei.js), so an abandoned payment
  // page never reaches the owner as a new order. If MONEI cannot be reached the
  // order is cancelled rather than left waiting for a payment that cannot happen.
  if (wantsCard) {
    try {
      const monei = await createMoneiPayment({
        reservationId,
        amountCents: total_cents,
        customerName: customer_name,
        customerEmail: customer_email,
        description: `Pedido ${reservationId} — ${getConfig("company_name") || "Web"}`,
      });
      db.prepare("UPDATE reservations SET monei_payment_id = ? WHERE id = ?").run(monei.id, reservationId);
      return res.status(201).json({
        success: true,
        id: reservationId,
        total_cents,
        shipping_cents,
        vat_included: true,
        vat_cents,
        b2b: false,
        payment: { method: "card" },
        redirect_url: monei.redirectUrl,
      });
    } catch (err) {
      console.error(`MONEI: no se pudo iniciar el pago de la reserva ${reservationId}:`, err.message);
      db.prepare("UPDATE reservations SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").run(
        reservationId,
      );
      return res.status(502).json({
        error: "No se pudo iniciar el pago con tarjeta. Inténtalo de nuevo en unos minutos.",
      });
    }
  }

  if (payment?.method === "transfer") payment.reference = `Reserva ${reservationId}`;

  const { itemsList, totals } = describeReservation({
    items: resolvedItems,
    vat_included,
    vat_cents,
    total_cents,
    zone_label: zone ? zone.label : null,
    shipping_cents,
  });
  await sendReservationMails({
    reservationId,
    customer_name,
    customer_email,
    customer_phone,
    notes,
    itemsList,
    totals,
    payment,
    b2bAccount,
  });

  res.status(201).json({
    success: true,
    id: reservationId,
    total_cents,
    shipping_cents,
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
