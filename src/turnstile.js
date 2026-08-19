import { getConfig } from "./db/database.js";

// Cloudflare Turnstile for the public contact form. Same resolution order as
// SMTP (src/mail/mailer.js): an env var wins over the value saved in the
// panel, so a Zeabur-level override doesn't need a panel edit. The site key
// is public (PUBLIC_CONFIG_KEYS, rendered into contacto.njk); the secret key
// never leaves the server.
export function getTurnstileSettings() {
  return {
    siteKey: process.env.TURNSTILE_SITE_KEY || getConfig("turnstile_site_key") || "",
    secretKey: process.env.TURNSTILE_SECRET_KEY || getConfig("turnstile_secret_key") || "",
  };
}

// Turnstile is opt-in: an instance with no keys configured shows no widget
// and the contact form works exactly as it did before this existed.
export function isTurnstileConfigured(settings = getTurnstileSettings()) {
  return !!(settings.siteKey && settings.secretKey);
}

// Verifies a widget response token against Cloudflare's siteverify endpoint.
// Returns false (never throws) on a network error or a rejected token, so a
// Cloudflare outage fails the submission closed rather than crashing the
// route — the visitor sees "try again", not a 500.
export async function verifyTurnstileToken(token, settings = getTurnstileSettings()) {
  if (!token) return false;
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: settings.secretKey, response: token }),
    });
    const data = await res.json();
    return data.success === true;
  } catch {
    return false;
  }
}
