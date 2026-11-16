import { Router } from "express";
import { rateLimit } from "../middleware/rateLimit.js";
import { asyncHandler } from "../middleware/async-handler.js";

// Address autocomplete for the checkout, from Spain's official geocoder
// (CartoCiudad, Instituto Geográfico Nacional). The browser asks this server
// and only this server: nothing about the visitor is forwarded upstream, and a
// failure just returns an empty list — typing the address by hand always works.
const router = Router();

// ADDRESS_API_URL exists so tests can point at a local fake; production never sets it.
const apiUrl = () =>
  process.env.ADDRESS_API_URL || "https://www.cartociudad.es/geocoder/api/geocoder/candidates";

// Public, like the checkout: cap volume per visitor so the endpoint cannot be
// used to hammer the geocoder.
const addressLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });

// The geocoder's answer to "calle alcalá" does not change between keystrokes,
// so the same query is reused for ten minutes. Only successful answers are
// cached: a failure is retried on the next keystroke.
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 500;
const cache = new Map(); // normalised query -> { at, suggestions }

const MAX_SUGGESTIONS = 6;
const MAX_LENGTH = 150;

// Everything sent back is clipped: it goes to the browser and into the
// reservation, and no field here has a reason to be long.
const clip = (value) => String(value).slice(0, MAX_LENGTH);

// "portal" is a street number, "callejero" a street without one; every other
// type (shops, villages, municipalities…) is not a delivery address.
const KEPT_TYPES = ["portal", "callejero"];

function mapSuggestions(candidates) {
  const suggestions = [];
  for (const candidate of candidates) {
    if (suggestions.length >= MAX_SUGGESTIONS) break;
    if (!KEPT_TYPES.includes(candidate?.type)) continue;
    if (typeof candidate.address !== "string") continue;
    const address = candidate.address.trim();
    if (!address) continue;
    const city = typeof candidate.poblacion === "string" ? candidate.poblacion.trim() : "";
    // CartoCiudad appends the town to the street ("CALLE ALCALA 50, Madrid");
    // the field already has its own town, so it is taken off when it is there.
    const street = city && address.endsWith(`, ${city}`) ? address.slice(0, -(city.length + 2)).trim() : address;
    const postal_code = typeof candidate.postalCode === "string" ? candidate.postalCode.trim() : "";
    const label = postal_code ? `${street}, ${city} (${postal_code})` : `${street}, ${city}`;
    suggestions.push({
      label: clip(label),
      street: clip(street),
      postal_code: clip(postal_code),
      city: clip(city),
    });
  }
  return suggestions;
}

// One upstream call. Returns the suggestions, or null when the geocoder could
// not be used, so the caller knows not to cache it.
async function lookUp(q) {
  try {
    const url = `${apiUrl()}?q=${encodeURIComponent(q)}&limit=10&no_process=municipio,provincia,comunidad_autonoma`;
    const response = await fetch(url, {
      // No IP, no cookies, no Referer: only the text being looked up.
      headers: { "User-Agent": "bl-site-package" },
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    let candidates;
    try {
      candidates = await response.json();
    } catch {
      throw new Error("la respuesta no es JSON");
    }
    if (!Array.isArray(candidates)) throw new Error("la respuesta no es una lista");
    return mapSuggestions(candidates);
  } catch (err) {
    // Never the typed text: it is the customer's address. A URL parse error
    // can echo it, so it is stripped from the reason.
    const reason = String(err?.message || err)
      .split(q)
      .join("…")
      .split(encodeURIComponent(q))
      .join("…");
    console.error("CartoCiudad: no se pudieron obtener sugerencias de dirección:", reason);
    return null;
  }
}

// GET /api/address/suggest?q=<text> -> { suggestions: [{ label, street, postal_code, city }] }
router.get(
  "/suggest",
  addressLimiter,
  asyncHandler(async (req, res) => {
    const q =
      typeof req.query.q === "string" ? req.query.q.trim().replace(/\s+/g, " ") : "";
    if (q.length < 3 || q.length > 100) return res.json({ suggestions: [] });

    const key = q.toLowerCase();
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return res.json({ suggestions: cached.suggestions });
    }

    const suggestions = await lookUp(q);
    if (suggestions) {
      // Map keeps insertion order: the first key is the oldest entry. Reusing a
      // key does not move it, which is fine — it is refreshed in place.
      if (cache.size >= CACHE_MAX && !cache.has(key)) {
        cache.delete(cache.keys().next().value);
      }
      cache.set(key, { at: Date.now(), suggestions });
    }
    res.json({ suggestions: suggestions || [] });
  }),
);

export default router;
