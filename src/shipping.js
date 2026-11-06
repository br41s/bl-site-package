// Shipping zones: where the business delivers and what each costs.
//
// One config key, `shipping_zones`, holding a JSON array
//   [{ "id": "peninsula", "label": "Península", "price_cents": 700 }, …]
// Prices are what the customer pays, VAT included. With no zones configured
// the checkout is unchanged (no selector, no shipping line). Anywhere not
// listed is not served: the cart offers an "Otros destinos" option that blocks
// the order, and POST /api/reservations refuses it too — the UI is not the
// boundary.
//
// Parsing is shared by the build (site/_data/site.js renders the selector) and
// the server (src/api/reservations.js prices the order), so they cannot
// disagree about what a zone costs.

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
    zones.push({ id, label, price_cents: z.price_cents });
  }
  return zones;
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
