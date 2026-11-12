import { getConfig } from "./db/database.js";

// MONEI card payments (src/api/monei.js) are opt-in per deploy. These live here,
// not in the router, because the site build (site/_data/site.js) has to ask
// "is card payment on?" to decide what the legal pages may say, and the build
// should not import Express to find out. Same split as src/turnstile.js.

// The API key only ever comes from the environment: it is the secret that also
// signs every callback, so it must never be a config row (config rows can be
// public, exported, or shown in the panel). site_url is the same origin the
// rest of the package builds absolute links from.
export function getMoneiSettings() {
  return {
    apiKey: (process.env.MONEI_API_KEY || "").trim(),
    siteUrl: (process.env.SITE_URL || getConfig("site_url") || "").trim().replace(/\/+$/, ""),
  };
}

// MONEI calls us back on an https URL, so an http or empty site_url means the
// payment could be taken but never confirmed: treat that as not configured.
export function isMoneiConfigured(settings = getMoneiSettings()) {
  return Boolean(settings.apiKey && /^https:\/\/[^/\s]+$/i.test(settings.siteUrl));
}

// orderId on MONEI's side: up to 40 chars of [A-Za-z0-9_@./#&+-].
export const moneiOrderId = (reservationId) => `R${reservationId}`;
