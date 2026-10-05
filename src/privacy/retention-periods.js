// How long personal data is kept. One source for the code that deletes it
// (src/privacy/retention.js) and the privacy policy that promises it
// (site/privacidad.njk, through site/_data/site.js), so the two cannot disagree.
// No database import here: the build reads this file too.
//
// - Contact messages: two years, long enough to follow up a conversation and
//   answer a later claim about it.
// - Orders (reservations + their lines): six years, the period commercial
//   records must be kept (Código de Comercio, art. 30).
export const CONTACT_RETENTION_MONTHS = 24;
export const ORDER_RETENTION_YEARS = 6;
