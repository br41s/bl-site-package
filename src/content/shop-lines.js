// The catalogue's two payment/delivery lines: one short, for meta
// descriptions, and one for the hero subtitle. Both are derived from config so
// no deploy ships another customer's wording.
//
// The payment half follows the same rule as paymentInstructions in
// src/api/reservations.js: with an IBAN, retail orders are paid by transfer
// before they are prepared, and card payments through MONEI are offered only
// when configured. "Sin pago por adelantado" was said before the transfer flow
// existed, and contradicted it.
//
// Pure functions: no config or database access, so they are tested directly.

// Lowercase payment phrase, no trailing period.
function paymentPhrase({ bankIban, cardPayments }) {
  if (cardPayments && bankIban) return "paga con tarjeta o por transferencia bancaria";
  if (cardPayments) return "paga con tarjeta";
  if (bankIban) return "paga por transferencia bancaria";
  return "paga al recibir tu pedido";
}

// "A" / "A y B" / "A, B y C", labels exactly as given, in array order.
function list(labels) {
  if (labels.length <= 1) return labels.join("");
  return labels.slice(0, -1).join(", ") + " y " + labels[labels.length - 1];
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// "Pide online y paga con tarjeta", no trailing period: meta descriptions add
// their own. The catalogue pages use `site.shop_payment_line` plus ".".
export function shopPaymentLine({ bankIban, cardPayments }) {
  return "Pide online y " + paymentPhrase({ bankIban, cardPayments });
}

// The hero subtitle, in full sentences and ending with a period. Delivery is
// only mentioned when zones are configured (src/shipping.js); with none the
// business does not advertise where it ships.
export function shopHeroLine({ bankIban, cardPayments, zones }) {
  const sentences = [
    "Elige tus productos y pídelos online en pocos clics.",
    capitalize(paymentPhrase({ bankIban, cardPayments })) + ".",
  ];
  const all = Array.isArray(zones) ? zones : [];
  const free = all.filter((z) => z.price_cents === 0);
  const paid = all.filter((z) => z.price_cents !== 0);
  if (free.length && paid.length) {
    sentences.push(
      "Envío gratis en " + list(free.map((z) => z.label)) + " y también enviamos a " + list(paid.map((z) => z.label)) + ".",
    );
  } else if (free.length) {
    sentences.push("Envío gratis en " + list(free.map((z) => z.label)) + ".");
  } else if (paid.length) {
    sentences.push("Enviamos a " + list(paid.map((z) => z.label)) + ".");
  }
  return sentences.join(" ");
}