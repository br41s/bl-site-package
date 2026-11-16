/**
 * Spanish postal code → shipping region, with no DOM and no Node APIs.
 *
 * Shared by the server (src/shipping.js tags each zone with its region) and
 * the browser (web/cart.js auto-selects the zone while the customer types the
 * postal code), and tested from src/. Keep it plain ES module code so both
 * sides can import the same file.
 */

export const REGIONS = ["peninsula", "baleares", "canarias", "ceuta", "melilla", "portugal"];

const REGION_LABELS = {
  peninsula: "Península",
  baleares: "Baleares",
  canarias: "Canarias",
  ceuta: "Ceuta",
  melilla: "Melilla",
  portugal: "Portugal",
};

// A Spanish five-digit code carries its province in the first two digits, and
// the provinces of Baleares, Las Palmas, Santa Cruz de Tenerife, Ceuta and
// Melilla are the ones that are not on the peninsula. A seven-digit run (or a
// Portuguese 1000-001) cannot be Spanish, so it is treated as Portugal.
export function postalRegion(postalCode) {
  if (typeof postalCode !== "string") return null;
  const value = postalCode.trim().replace(/\s+/g, "");
  if (/^\d{4}-\d{3}$/.test(value) || /^\d{7}$/.test(value)) return "portugal";
  if (/^\d{5}$/.test(value)) {
    const province = Number(value.slice(0, 2));
    if (province === 7) return "baleares";
    if (province === 35 || province === 38) return "canarias";
    if (province === 51) return "ceuta";
    if (province === 52) return "melilla";
    if (province >= 1 && province <= 52) return "peninsula";
  }
  return null;
}

export function regionLabel(region) {
  return Object.prototype.hasOwnProperty.call(REGION_LABELS, region) ? REGION_LABELS[region] : "";
}

export function zoneForPostalCode(zones, postalCode) {
  if (!Array.isArray(zones)) return null;
  const region = postalRegion(postalCode);
  if (!region) return null;
  return zones.find((zone) => zone && zone.region === region) || null;
}

// true/false when both sides have a known region; null when the postal code or
// the zone says nothing, so the caller can tell "different" from "no idea".
export function zoneMatchesPostalCode(zone, postalCode) {
  const region = postalRegion(postalCode);
  if (!zone || !REGIONS.includes(zone.region) || !region) return null;
  return zone.region === region;
}
