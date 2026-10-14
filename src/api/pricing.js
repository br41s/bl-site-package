import { Router } from "express";
import db, { getConfig } from "../db/database.js";
import { requireAuth } from "../middleware/auth.js";
import { scheduleRebuild } from "../build/rebuild.js";
import { DEFAULT_PVO_ADJUST_PCT } from "../sync/liderpapel/mapping.js";
import { retailPriceCents } from "../sync/liderpapel/parse.js";

// Retail price adjustments: what the public price (PVP) is over — or under —
// the distributor's suggested retail price, the PVO (src/sync/liderpapel/
// mapping.js). 0 is the catalogue price.
//
// PVP is not computed at display time. The sync writes it into
// products.price_cents, and everything reads that one column — the built
// pages, their JSON-LD, the cart, the reservation, and the B2B discount, which
// comes off it. So an adjustment is applied where the price is made: the sync
// prices every product with adjustFor(category), and saving one here re-prices
// the stored catalogue from products.pvo_ex_vat (or cost_ex_vat, for the few
// products the feed gives no PVO) with the same retailPriceCents(), then
// rebuilds the site once.
//
// A general adjustment (config key liderpapel_pvo_adjust_pct) plus an optional
// one per catalogue category that replaces it — the same shape as the B2B
// discounts. The pre-PVO margins (liderpapel_margin_pct, category_margins) are
// left in place and read by nothing: reusing them would have put Shoroban's
// 40 % cost margin on top of the catalogue price the day this shipped.

const router = Router();

// An adjustment we are willing to price with: a percentage over the PVO, from
// MIN_ADJUST_PCT (a sale below the catalogue) to MAX_ADJUST_PCT, rounded to two
// decimals; null if not. It guards the PUT endpoint and every stored value on
// READ (a REAL column happily stores text, and a NaN adjustment would fail the
// NOT NULL price_cents write in the middle of a sync).
//
// The bounds are typo guards: "-50" is a clearance, "-500" gives the catalogue
// away; "10" is plausible, "100" typed for "10" doubles a whole category's PVP
// in one click, live on the public site. "12,5" from a Spanish keyboard is as
// valid as "12.5".
export const MIN_ADJUST_PCT = -50;
export const MAX_ADJUST_PCT = 100;

export function parseAdjustPct(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const text = String(value).trim().replace(",", ".");
  const n = Number(text);
  if (text === "" || !Number.isFinite(n) || n < MIN_ADJUST_PCT || n > MAX_ADJUST_PCT) return null;
  return Math.round(n * 100) / 100;
}

const RANGE_TEXT = `un porcentaje entre ${MIN_ADJUST_PCT} y ${MAX_ADJUST_PCT}`;

export function getDefaultAdjustPct() {
  const value = parseAdjustPct(getConfig("liderpapel_pvo_adjust_pct") ?? "");
  return value === null ? DEFAULT_PVO_ADJUST_PCT : value;
}

// A malformed row is skipped, so its category falls back to the general
// adjustment — the same as having no row at all.
export function getCategoryAdjustments() {
  const map = {};
  for (const row of db.prepare("SELECT category, adjust_pct FROM category_price_adjust").all()) {
    const value = parseAdjustPct(row.adjust_pct);
    if (value !== null) map[row.category] = value;
  }
  return map;
}

// Pricing context — load it once, then price every product with adjustFor.
export function adjustPricing() {
  const adjustments = getCategoryAdjustments();
  const defaultPct = getDefaultAdjustPct();
  return {
    defaultPct,
    adjustments,
    adjustFor: (category) =>
      Object.prototype.hasOwnProperty.call(adjustments, category || "")
        ? adjustments[category || ""]
        : defaultPct,
  };
}

// Re-prices every product that has something to price from, writing only the
// prices that actually changed. Rows with neither a PVO nor a cost yet (synced
// before the columns existed) keep their price until the next sync fills them.
export function repriceCatalog() {
  const { adjustFor } = adjustPricing();
  const rows = db
    .prepare("SELECT id, category, pvo_ex_vat, cost_ex_vat, vat_rate, price_cents FROM products")
    .all();
  const update = db.prepare(
    "UPDATE products SET price_cents = ?, updated_at = datetime('now') WHERE id = ?",
  );
  let changed = 0;
  db.transaction(() => {
    for (const row of rows) {
      const price = retailPriceCents(row, adjustFor(row.category));
      if (price === null || price === row.price_cents) continue;
      update.run(price, row.id);
      changed += 1;
    }
  })();
  return changed;
}

// The same "nothing to price from" rule as retailPriceCents, in SQL.
function pendingCount() {
  return db
    .prepare(
      "SELECT COUNT(*) AS n FROM products WHERE COALESCE(pvo_ex_vat, 0) <= 0 AND COALESCE(cost_ex_vat, 0) <= 0",
    )
    .get().n;
}

// GET /api/pricing/adjustments — the general adjustment, and every category
// the live catalogue has with its product count and its own adjustment (null =
// uses the general one). Categories that still carry an adjustment after
// leaving the catalogue are listed with total 0, so the admin can see and
// clear them. `pending` counts products that cannot be re-priced until the
// next sync.
router.get("/adjustments", requireAuth, (req, res) => {
  const counts = new Map();
  for (const { category } of db
    .prepare("SELECT category FROM products WHERE active = 1 AND feed_active = 1")
    .all()) {
    const label = category || "";
    if (!label.trim()) continue;
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  const { defaultPct, adjustments } = adjustPricing();
  for (const category of Object.keys(adjustments)) {
    if (!counts.has(category)) counts.set(category, 0);
  }
  const categories = Array.from(counts, ([category, total]) => ({
    category,
    total,
    adjust_pct: Object.prototype.hasOwnProperty.call(adjustments, category)
      ? adjustments[category]
      : null,
  })).sort((a, b) => a.category.localeCompare(b.category, "es"));

  res.json({ default_pct: defaultPct, categories, pending: pendingCount() });
});

// PUT /api/pricing/adjustments — { default_pct?, adjustments?: { "<category>": pct | null | "" } }
// Partial: an absent key is left alone, and so is a category not in
// `adjustments`; null or "" removes a category's own adjustment so it falls
// back to the general one. All-or-nothing — one bad value rejects the whole
// request before anything is written. Then the catalogue is re-priced and, if
// any price moved, the site rebuilt once.
router.put("/adjustments", requireAuth, (req, res) => {
  const { default_pct, adjustments } = req.body;

  let defaultPct;
  if (default_pct !== undefined) {
    defaultPct = parseAdjustPct(default_pct);
    if (defaultPct === null) {
      return res.status(400).json({ error: `El ajuste general debe ser ${RANGE_TEXT}.` });
    }
  }

  const upserts = [];
  const removals = [];
  if (adjustments !== undefined) {
    if (!adjustments || typeof adjustments !== "object" || Array.isArray(adjustments)) {
      return res
        .status(400)
        .json({ error: "Formato no válido: se esperaba { adjustments: { categoría: % } }" });
    }
    for (const [rawCategory, value] of Object.entries(adjustments)) {
      const category = rawCategory.trim();
      if (!category || category.length > 200) {
        return res.status(400).json({ error: "Nombre de categoría no válido." });
      }
      if (value === null || value === "") {
        removals.push(category);
        continue;
      }
      const pct = parseAdjustPct(value);
      if (pct === null) {
        return res.status(400).json({
          error: `Ajuste no válido para «${category}»: usa ${RANGE_TEXT}.`,
        });
      }
      upserts.push([category, pct]);
    }
  }

  const upsert = db.prepare(
    `INSERT INTO category_price_adjust (category, adjust_pct, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(category) DO UPDATE SET adjust_pct = excluded.adjust_pct, updated_at = excluded.updated_at`,
  );
  const remove = db.prepare("DELETE FROM category_price_adjust WHERE category = ?");
  db.transaction(() => {
    // Written directly rather than through setConfig, which would rebuild the
    // site even when no price moved. The rebuild below is the only one.
    if (defaultPct !== undefined) {
      db.prepare(
        "INSERT OR REPLACE INTO config (key, value, updated_at) VALUES ('liderpapel_pvo_adjust_pct', ?, datetime('now'))",
      ).run(String(defaultPct));
    }
    for (const [category, pct] of upserts) upsert.run(category, pct);
    for (const category of removals) remove.run(category);
  })();

  const repriced = repriceCatalog();
  if (repriced > 0) scheduleRebuild();

  res.json({ success: true, repriced, pending: pendingCount() });
});

export default router;
