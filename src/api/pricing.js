import { Router } from "express";
import db, { getConfig } from "../db/database.js";
import { requireAuth } from "../middleware/auth.js";
import { scheduleRebuild } from "../build/rebuild.js";
import { DEFAULT_MARGIN_PCT } from "../sync/liderpapel/mapping.js";
import { pvpCents } from "../sync/liderpapel/parse.js";

// Retail margins: what the public price (PVP) is over the distributor's cost.
//
// PVP is not computed at display time. The sync writes it into
// products.price_cents, and everything reads that one column — the built
// pages, their JSON-LD, the cart, the reservation, and the B2B discount, which
// comes off it. So a margin is applied where the price is made: the sync
// prices every product with marginFor(category), and saving a margin here
// re-prices the stored catalogue from products.cost_ex_vat with the same
// pvpCents(), then rebuilds the site once.
//
// A general margin (config key liderpapel_margin_pct) plus an optional one per
// catalogue category that replaces it — the same shape as the B2B discounts.

const router = Router();

// A margin we are willing to price with: a percentage over cost (40 = 40%),
// from 0 (sell at cost) to MAX_MARGIN_PCT, rounded to two decimals; null if
// not. It guards the PUT endpoint and every stored value on READ (a REAL
// column happily stores text, and a NaN margin would fail the NOT NULL
// price_cents write in the middle of a sync).
//
// The ceiling is a typo guard: margins over 100% are normal in stationery, but
// "400" typed for "40" would multiply a whole category's PVP by 3.5 in one
// click, live on the public site. "12,5" from a Spanish keyboard is as valid
// as "12.5".
export const MAX_MARGIN_PCT = 200;

export function parseMarginPct(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const n = Number(String(value).trim().replace(",", "."));
  if (String(value).trim() === "" || !Number.isFinite(n) || n < 0 || n > MAX_MARGIN_PCT) return null;
  return Math.round(n * 100) / 100;
}

export function getDefaultMarginPct() {
  const value = parseMarginPct(getConfig("liderpapel_margin_pct") ?? "");
  return value === null ? DEFAULT_MARGIN_PCT : value;
}

// A malformed row is skipped, so its category falls back to the general
// margin — the same as having no row at all.
export function getCategoryMargins() {
  const map = {};
  for (const row of db.prepare("SELECT category, margin_pct FROM category_margins").all()) {
    const value = parseMarginPct(row.margin_pct);
    if (value !== null) map[row.category] = value;
  }
  return map;
}

// Pricing context — load it once, then price every product with marginFor.
export function marginPricing() {
  const margins = getCategoryMargins();
  const defaultPct = getDefaultMarginPct();
  return {
    defaultPct,
    margins,
    marginFor: (category) =>
      Object.prototype.hasOwnProperty.call(margins, category || "")
        ? margins[category || ""]
        : defaultPct,
  };
}

// Re-prices every product that has a stored cost, writing only the prices
// that actually changed. Rows with no cost yet (synced before cost_ex_vat
// existed) keep their price until the next sync gives them one.
export function repriceCatalog() {
  const { marginFor } = marginPricing();
  const rows = db
    .prepare("SELECT id, category, cost_ex_vat, price_cents FROM products WHERE cost_ex_vat IS NOT NULL")
    .all();
  const update = db.prepare(
    "UPDATE products SET price_cents = ?, updated_at = datetime('now') WHERE id = ?",
  );
  let changed = 0;
  db.transaction(() => {
    for (const row of rows) {
      const price = pvpCents(row.cost_ex_vat, marginFor(row.category));
      if (price === row.price_cents) continue;
      update.run(price, row.id);
      changed += 1;
    }
  })();
  return changed;
}

function pendingCount() {
  return db.prepare("SELECT COUNT(*) AS n FROM products WHERE cost_ex_vat IS NULL").get().n;
}

// GET /api/pricing/margins — the general margin, and every category the live
// catalogue has with its product count and its own margin (null = uses the
// general one). Categories that still carry a margin after leaving the
// catalogue are listed with total 0, so the admin can see and clear them.
// `pending` counts products that cannot be re-priced until the next sync.
router.get("/margins", requireAuth, (req, res) => {
  const counts = new Map();
  for (const { category } of db
    .prepare("SELECT category FROM products WHERE active = 1 AND feed_active = 1")
    .all()) {
    const label = category || "";
    if (!label.trim()) continue;
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  const { defaultPct, margins } = marginPricing();
  for (const category of Object.keys(margins)) {
    if (!counts.has(category)) counts.set(category, 0);
  }
  const categories = Array.from(counts, ([category, total]) => ({
    category,
    total,
    margin_pct: Object.prototype.hasOwnProperty.call(margins, category) ? margins[category] : null,
  })).sort((a, b) => a.category.localeCompare(b.category, "es"));

  res.json({ default_pct: defaultPct, categories, pending: pendingCount() });
});

// PUT /api/pricing/margins — { default_pct?, margins?: { "<category>": pct | null | "" } }
// Partial: an absent key is left alone, and so is a category not in `margins`;
// null or "" removes a category's own margin so it falls back to the general
// one. All-or-nothing — one bad value rejects the whole request before anything
// is written. Then the catalogue is re-priced and, if any price moved, the site
// rebuilt once.
router.put("/margins", requireAuth, (req, res) => {
  const { default_pct, margins } = req.body;

  let defaultPct;
  if (default_pct !== undefined) {
    defaultPct = parseMarginPct(default_pct);
    if (defaultPct === null) {
      return res.status(400).json({ error: "El margen general debe ser un porcentaje entre 0 y 200." });
    }
  }

  const upserts = [];
  const removals = [];
  if (margins !== undefined) {
    if (!margins || typeof margins !== "object" || Array.isArray(margins)) {
      return res.status(400).json({ error: "Formato no válido: se esperaba { margins: { categoría: % } }" });
    }
    for (const [rawCategory, value] of Object.entries(margins)) {
      const category = rawCategory.trim();
      if (!category || category.length > 200) {
        return res.status(400).json({ error: "Nombre de categoría no válido." });
      }
      if (value === null || value === "") {
        removals.push(category);
        continue;
      }
      const pct = parseMarginPct(value);
      if (pct === null) {
        return res.status(400).json({
          error: `Margen no válido para «${category}»: usa un porcentaje entre 0 y 200.`,
        });
      }
      upserts.push([category, pct]);
    }
  }

  const upsert = db.prepare(
    `INSERT INTO category_margins (category, margin_pct, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(category) DO UPDATE SET margin_pct = excluded.margin_pct, updated_at = excluded.updated_at`,
  );
  const remove = db.prepare("DELETE FROM category_margins WHERE category = ?");
  db.transaction(() => {
    // Written directly rather than through setConfig, which would rebuild the
    // site even when no price moved. The rebuild below is the only one.
    if (defaultPct !== undefined) {
      db.prepare(
        "INSERT OR REPLACE INTO config (key, value, updated_at) VALUES ('liderpapel_margin_pct', ?, datetime('now'))",
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
