// Shipping zones: where the business delivers and what each costs.
//
// One config key, `shipping_zones`, holding a JSON array
//   [{ "id": "peninsula", "label": "Península", "price_cents": 700, "region": "peninsula" }, …]
// Prices are what the customer pays, VAT included. `region` is optional: one
// of the REGIONS in web/postal-region.js, it lets the cart pick the zone from
// the postal code. Without it, an id that is itself a region name (the shape
// existing deploys use) is taken as the region. With no zones configured the
// checkout has no selector and no shipping line. Anywhere not listed is not
// served: the cart offers an "Otros destinos" option that blocks the order, and
// POST /api/reservations refuses it too — the UI is not the boundary.
//
// Parsing is shared by the build (site/_data/site.js renders the selector) and
// the server (src/api/reservations.js prices the order), so they cannot
// disagree about what a zone costs or which region it belongs to.

import { REGIONS } from "../web/postal-region.js";

export const OTHER_ZONE_ID = "otros";

export function parseShippingZones(raw) {
  let list;
  try {
    list = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const zones = [];
  for (const z of list) {
    const id = typeof z?.id === "string" ? z.id.trim() : "";
    const label = typeof z?.label === "string" ? z.label.trim() : "";
    if (!id || !label || id === OTHER_ZONE_ID || seen.has(id)) continue;
    if (!Number.isInteger(z.price_cents) || z.price_cents < 0) continue;
    seen.add(id);
    const region = REGIONS.includes(z.region) ? z.region : REGIONS.includes(id) ? id : null;
    const zone = { id, label, price_cents: z.price_cents };
    if (region) zone.region = region;
    zones.push(zone);
  }
  return zones;
}

// The delivery address as one line, which is what the reservation stores and
// both emails print: street (with the floor/door if given), then the postal
// code and the town. Empty parts are dropped, so a half-filled form still
// reads as a sentence ("CALLE ALCALA 50, 2ºB, 28014 Madrid").
export function formatShippingAddress({ address, extra, postal_code, city }) {
  const one = (value) => (typeof value === "string" ? value.trim() : "");
  const street = [one(address), one(extra)].filter(Boolean).join(", ");
  const place = [one(postal_code), one(city)].filter(Boolean).join(" ");
  return [street, place].filter(Boolean).join(", ");
}

// Strict form for the panel/API: every entry must be valid, none dropped
// silently. "" clears the zones.
export function isValidShippingZones(raw) {
  if (raw === "") return true;
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) && list.length > 0 && parseShippingZones(list).length === list.length;
  } catch {
    return false;
  }
}
