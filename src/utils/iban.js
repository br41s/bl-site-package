// Bank details for pay-by-transfer (config keys bank_holder / bank_iban /
// bank_bic). A typo in a stored IBAN sends every customer's transfer to the
// wrong account or back to them, so the panel refuses one whose check digits
// do not add up.

export function normalizeIban(value) {
  return String(value || "").replace(/\s+/g, "").toUpperCase();
}

// ISO 13616: move the country code and check digits to the end, turn letters
// into numbers (A=10 … Z=35), and the result mod 97 must be 1. Computed in
// chunks because the number is far beyond Number's integer precision.
export function isValidIban(value) {
  const iban = normalizeIban(value);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const digits = (iban.slice(4) + iban.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let remainder = 0;
  for (let i = 0; i < digits.length; i += 7) {
    remainder = Number(String(remainder) + digits.slice(i, i + 7)) % 97;
  }
  return remainder === 1;
}

export function isValidBic(value) {
  return /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(String(value || "").trim().toUpperCase());
}

// "ES43 0182 4731 8402 0160 5267" — how people read and type it.
export function formatIban(value) {
  return normalizeIban(value).replace(/(.{4})(?=.)/g, "$1 ");
}
