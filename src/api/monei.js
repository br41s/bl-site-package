import express, { Router } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import db from "../db/database.js";
import { getMoneiSettings, isMoneiConfigured, moneiOrderId } from "../monei-config.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { describeReservation, sendReservationMails } from "../mail/reservation-mails.js";

// Card payment through MONEI's hosted payment page. The customer is sent to
// MONEI to pay, so no card data ever reaches this server or this site's
// JavaScript. Two halves:
//
//   1. createMoneiPayment(): called by POST /api/reservations. Server-side,
//      with the amount the server computed, and returns the page to redirect to.
//   2. POST /api/monei/callback: MONEI tells us how the payment ended. This is
//      the ONLY thing that changes an order's state; the customer returning to
//      /pedido-recibido proves nothing (they can close the tab, or type the URL).
//
// Opt-in per deploy: with no MONEI_API_KEY the site behaves as before.
const router = Router();

export { getMoneiSettings, isMoneiConfigured, moneiOrderId };

// MONEI_API_URL exists so tests can point at a local fake; production never sets it.
const apiUrl = () => process.env.MONEI_API_URL || "https://api.monei.com/v1/payments";

// Creates the payment and returns { id, redirectUrl }. Throws on anything but a
// usable answer; the route turns that into a clean 502 and never forwards
// MONEI's text to the browser.
export async function createMoneiPayment({ reservationId, amountCents, customerName, customerEmail, description }) {
  const { apiKey, siteUrl } = getMoneiSettings();
  const res = await fetch(apiUrl(), {
    method: "POST",
    // The key goes in Authorization as is, with no "Bearer" (MONEI's docs).
    headers: { Authorization: apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      amount: amountCents,
      currency: "EUR",
      orderId: moneiOrderId(reservationId),
      description,
      // No phone: MONEI wants E.164 and ours is free text, so a "612 34 56 78"
      // would turn a valid order into a 422.
      customer: { email: customerEmail, name: customerName },
      callbackUrl: `${siteUrl}/api/monei/callback`,
      completeUrl: `${siteUrl}/pedido-recibido`,
      failUrl: `${siteUrl}/carrito?pago=error`,
      cancelUrl: `${siteUrl}/carrito`,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const payment = await res.json().catch(() => null);
  const redirectUrl = payment?.nextAction?.redirectUrl || payment?.redirectUrl;
  if (!res.ok || !payment?.id || typeof redirectUrl !== "string" || !redirectUrl.startsWith("https://")) {
    throw new Error(`MONEI no creó el pago (HTTP ${res.status}): ${payment?.message || "respuesta inesperada"}`);
  }
  return { id: payment.id, redirectUrl };
}

// MONEI-Signature: "t=<timestamp>,v1=<hex>". The signature is HMAC-SHA256 of
// "<t>.<raw body>" keyed with the API key. It must be computed over the bytes
// MONEI sent, which is why this route is mounted before express.json().
// Schemes other than v1 are ignored, so a header cannot downgrade the check.
// No time window on t: MONEI signs a payment callback once and may retry it
// hours later; replaying one is harmless because applying it is idempotent.
export function verifyMoneiSignature(rawBody, header, apiKey) {
  if (!apiKey || typeof header !== "string") return false;
  let timestamp = null;
  const signatures = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") timestamp = value;
    else if (key === "v1") signatures.push(value);
  }
  if (!timestamp || signatures.length === 0) return false;
  const expected = Buffer.from(
    createHmac("sha256", apiKey)
      .update(Buffer.concat([Buffer.from(`${timestamp}.`), Buffer.from(rawBody)]))
      .digest("hex"),
  );
  return signatures.some((sig) => {
    const given = Buffer.from(sig);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

const FAILED_STATUSES = ["FAILED", "CANCELED", "EXPIRED"];

// Applies a verified payment to its reservation. Returns an HTTP status for
// MONEI: 200 = got it (it stops retrying), 404 = not ready or unknown (it retries).
async function applyPayment(payment) {
  const match = /^R(\d+)$/.exec(String(payment?.orderId || ""));
  const reservation = match && db.prepare("SELECT * FROM reservations WHERE id = ?").get(Number(match[1]));
  // The payment id must be the one we stored when we created it: an order id
  // alone is guessable, and another payment must not confirm this order.
  if (!reservation || !payment.id || reservation.monei_payment_id !== payment.id) return 404;

  if (payment.status === "SUCCEEDED") {
    // What was charged must be what the server priced. A mismatch is not applied
    // and not retried (retrying cannot fix it): it is logged for a person to look at.
    if (payment.amount !== reservation.total_cents || payment.currency !== "EUR") {
      console.error(
        `MONEI: el pago ${payment.id} no coincide con la reserva ${reservation.id} ` +
          `(cobrado ${payment.amount} ${payment.currency}, esperado ${reservation.total_cents} EUR). REVISAR.`,
      );
      return 200;
    }
    // One statement, so a retried callback finds paid_at set and changes nothing.
    // A late success on an order we had already cancelled (an expired payment page
    // that was paid anyway) still counts: the money has been taken. An order the
    // panel has moved on keeps its status; it only gains paid_at.
    const changed = db
      .prepare(
        `UPDATE reservations
            SET paid_at = datetime('now'), updated_at = datetime('now'),
                status = CASE WHEN status IN ('awaiting_payment', 'cancelled') THEN 'confirmed' ELSE status END
          WHERE id = ? AND paid_at IS NULL`,
      )
      .run(reservation.id).changes;
    if (changed) await mailPaidReservation(reservation);
  } else if (FAILED_STATUSES.includes(payment.status)) {
    db.prepare(
      "UPDATE reservations SET status = 'cancelled', updated_at = datetime('now') WHERE id = ? AND paid_at IS NULL AND status = 'awaiting_payment'",
    ).run(reservation.id);
  }
  // PENDING, AUTHORIZED, REFUNDED...: nothing to do here.
  return 200;
}

// The order is announced when it is paid, not when it is created, so an
// abandoned payment page never reaches the owner as a new order.
async function mailPaidReservation(reservation) {
  const items = db.prepare("SELECT * FROM reservation_items WHERE reservation_id = ?").all(reservation.id);
  const { itemsList, totals } = describeReservation({
    items,
    vat_included: reservation.vat_included,
    vat_cents: reservation.vat_cents,
    total_cents: reservation.total_cents,
    zone_label: reservation.shipping_zone,
    shipping_cents: reservation.shipping_cents,
  });
  await sendReservationMails({
    reservationId: reservation.id,
    customer_name: reservation.customer_name,
    customer_email: reservation.customer_email,
    customer_phone: reservation.customer_phone,
    notes: reservation.notes,
    itemsList,
    totals,
    payment: { method: "card" },
    b2bAccount: null,
  });
}

// express.raw, not the global express.json(): the signature covers the exact bytes.
router.post(
  "/callback",
  express.raw({ type: () => true, limit: "100kb" }),
  asyncHandler(async (req, res) => {
    const { apiKey } = getMoneiSettings();
    if (!Buffer.isBuffer(req.body) || !verifyMoneiSignature(req.body, req.get("MONEI-Signature"), apiKey)) {
      return res.status(401).json({ error: "Firma no válida" });
    }
    let payment;
    try {
      payment = JSON.parse(req.body.toString("utf8"));
    } catch {
      return res.status(400).json({ error: "Cuerpo no válido" });
    }
    const status = await applyPayment(payment);
    res.status(status).json({ received: status === 200 });
  }),
);

export default router;
