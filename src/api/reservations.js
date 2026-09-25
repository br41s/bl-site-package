import { Router } from "express";
import nodemailer from "nodemailer";
import db, { getConfig } from "../db/database.js";
import { requireAuth } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { resolveB2bAccount, b2bPricing, b2bUnitPriceCents, vatCents, B2B_VAT_RATE } from "./b2b.js";
import { asyncHandler } from "../middleware/async-handler.js";

const router = Router();

// Public checkout endpoint: cap volume to blunt spam/DB-flooding.
const reservationLimiter = rateLimit({ windowMs: 60 * 1000, max: 10 });

const VALID_STATUSES = ["pending", "confirmed", "ready_for_pickup", "completed", "cancelled"];

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

  const insertReservation = db.transaction(() => {
    const result = db
      .prepare(
        "INSERT INTO reservations (customer_name, customer_email, customer_phone, notes, total_cents, b2b_account_id, b2b_company, vat_included, vat_cents) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        customer_name,
        customer_email,
        customer_phone,
        notes,
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

  const smtpHost = process.env.SMTP_HOST || getConfig("smtp_host");
  const smtpPort = parseInt(process.env.SMTP_PORT || getConfig("smtp_port") || "587", 10);
  const smtpUser = process.env.SMTP_USER || getConfig("smtp_user");
  const smtpPass = process.env.SMTP_PASS || getConfig("smtp_pass");
  const notifyEmail = process.env.NOTIFY_EMAIL || getConfig("notify_email");

  if (smtpHost && smtpUser && smtpPass && notifyEmail) {
    try {
      const transporter = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpPort === 465,
        auth: { user: smtpUser, pass: smtpPass },
      });
      const eur = (cents) => `${(cents / 100).toFixed(2)} €`;
      const itemsList = resolvedItems
        .map((i) => `- ${i.quantity} x ${i.product_name} (${eur(i.unit_price_cents)}${vat_included ? "" : " sin IVA"})`)
        .join("\n");
      const totals = vat_included
        ? `Total: ${eur(total_cents)}`
        : `Total sin IVA: ${eur(total_cents)}\nIVA (${Math.round(B2B_VAT_RATE * 100)} %): ${eur(vat_cents)}\nTotal con IVA: ${eur(total_cents + vat_cents)}`;
      const b2bLine = b2bAccount
        ? `Cuenta de empresa: ${b2bAccount.company_name}${b2bAccount.tax_id ? ` (${b2bAccount.tax_id})` : ""} — precios profesionales aplicados\n`
        : "";
      await transporter.sendMail({
        from: `"${customer_name}" <${smtpUser}>`,
        to: notifyEmail,
        subject: `Nueva reserva #${reservationId}${b2bAccount ? ` (empresa: ${b2bAccount.company_name})` : ""}`,
        text: `${b2bLine}Cliente: ${customer_name}\nEmail: ${customer_email}\nTeléfono: ${customer_phone}\n\nProductos:\n${itemsList}\n\n${totals}\n\nNotas: ${notes}`,
      });
    } catch (err) {
      console.error("Error enviando email de notificación de reserva:", err.message);
    }
  }

  res.status(201).json({
    success: true,
    id: reservationId,
    total_cents,
    vat_included: Boolean(vat_included),
    vat_cents,
    b2b: Boolean(b2bAccount),
  });
}));

// PUT /api/reservations/:id — status update
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
