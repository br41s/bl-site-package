import { getConfig } from "../db/database.js";
import { getMailSettings, isNotifyEmailConfigured, isSmtpConfigured, sendMail } from "./mailer.js";

// The two emails a reservation sends (owner notification, customer copy).
// Moved out of src/api/reservations.js so the MONEI callback can send them too:
// a card order is announced when the payment succeeds, not when it is created,
// and both places must word it the same way.

export const eur = (cents) => `${(cents / 100).toFixed(2)} €`;

export function paymentText(payment) {
  if (!payment) return "Te avisaremos para confirmar la entrega.";
  if (payment.method === "usual") {
    return "El pago se hará según tu forma de pago habitual con nosotros. Te avisaremos para confirmar la entrega.";
  }
  if (payment.method === "card") {
    return "Hemos recibido tu pago con tarjeta. Prepararemos tu pedido y te avisaremos.";
  }
  const lines = [`Para completar tu reserva, haz una transferencia de ${eur(payment.amount_cents)} a:`];
  if (payment.holder) lines.push(`Titular: ${payment.holder}`);
  lines.push(`IBAN: ${payment.iban}`);
  if (payment.bic) lines.push(`BIC: ${payment.bic}`);
  lines.push(`Concepto: ${payment.reference}`, "", "Prepararemos tu pedido en cuanto recibamos el pago.");
  return lines.join("\n");
}

// The item lines and totals block of both emails, from what is stored on the
// reservation. items: [{ product_name, unit_price_cents, quantity }].
export function describeReservation({ items, vat_included, vat_cents, total_cents, zone_label, shipping_cents }) {
  const itemsList = items
    .map((i) => `- ${i.quantity} x ${i.product_name} (${eur(i.unit_price_cents)}${vat_included ? "" : " sin IVA"})`)
    .join("\n");
  const shippingLine = zone_label
    ? `\nEnvío (${zone_label}): ${eur(shipping_cents)}${vat_included ? "" : " sin IVA"}`
    : "";
  const totals = vat_included
    ? `${shippingLine ? shippingLine.trimStart() + "\n" : ""}Total: ${eur(total_cents)}`
    : `${shippingLine ? shippingLine.trimStart() + "\n" : ""}Total sin IVA: ${eur(total_cents)}\nIVA: ${eur(vat_cents)}\nTotal con IVA: ${eur(total_cents + vat_cents)}`;
  return { itemsList, totals };
}

// Owner notification and customer copy go out together, not one after the
// other: the checkout waits for both, and SMTP can take seconds each. Neither
// throws: the reservation is stored and the screen already shows the details.
export async function sendReservationMails({
  reservationId,
  customer_name,
  customer_email,
  customer_phone,
  notes,
  itemsList,
  totals,
  payment,
  b2bAccount,
}) {
  const settings = getMailSettings();

  const notifyOwner = async () => {
    if (!isSmtpConfigured(settings) || !isNotifyEmailConfigured(settings)) return;
    try {
      const b2bLine = b2bAccount
        ? `Cuenta de empresa: ${b2bAccount.company_name}${b2bAccount.tax_id ? ` (${b2bAccount.tax_id})` : ""} — precios profesionales aplicados\n`
        : "";
      const paymentLine = payment?.method === "transfer"
        ? `Pago: por transferencia, concepto «${payment.reference}»\n`
        : payment?.method === "card"
          ? "Pago: con tarjeta (MONEI), ya cobrado\n"
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
  // notify_email (that is the owner's address).
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
}
