import { Router } from "express";
import jwt from "jsonwebtoken";
import db, { getConfig } from "../db/database.js";
import { requireAuth } from "../middleware/auth.js";
import { scheduleRebuild } from "../build/rebuild.js";
import { normalizeForSearch } from "../utils/text.js";
import { toSlug } from "../sync/liderpapel/parse.js";

const router = Router();

// GET /api/products — list (public: only active; authenticated: all)
router.get("/", (req, res) => {
  const authHeader = req.headers["authorization"];
  const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const panelToken = req.headers["x-panel-token"];
  const token = bearer || (typeof panelToken === "string" ? panelToken : null);

  let isAuth = false;
  if (token) {
    const secret = process.env.JWT_SECRET || getConfig("jwt_secret");
    if (secret) {
      try {
        jwt.verify(token, secret);
        isAuth = true;
      } catch {
        isAuth = false;
      }
    }
  }

  const gtin = typeof req.query.gtin === "string" ? req.query.gtin.trim() : "";
  const mpn = typeof req.query.mpn === "string" ? req.query.mpn.trim() : "";
  if (gtin || mpn) {
    // Exact-identifier lookup — "which live product has this barcode/
    // reference" (needed to map a dead product URL to its current one, see
    // src/api/redirects.js) is a different question from the free-text
    // search below and needs an exact match, not a LIKE. Authenticated only:
    // this is a tool-facing lookup, not something a storefront visitor needs.
    if (!isAuth) return res.status(401).json({ error: "No autorizado" });
    const row = gtin
      ? db.prepare("SELECT * FROM products WHERE gtin = ? AND active = 1 AND feed_active = 1").get(gtin)
      : db.prepare("SELECT * FROM products WHERE mpn = ? AND active = 1 AND feed_active = 1").get(mpn);
    return res.json({ products: row ? [row] : [] });
  }

  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const activeClause = isAuth ? "" : "WHERE p.active = 1";
  // Every word must appear somewhere, in any order.
  //
  // This used to LIKE the whole query as one substring, so a search only
  // worked if you happened to type the distributor's exact wording in its
  // exact order: "destructora de documentos rexel" found 22 products,
  // "Destructora Rexel" found none, and "bic boligrafo" found none while
  // "boligrafo bic" found 94. Nobody types a warehouse label from memory.
  //
  // Each word is matched against the distributor's text and against ours, so
  // a query can mix the two — the brand from the feed and a word from the
  // title we wrote. Identifiers ride along in p.search_text, put there by the
  // sync, because "2104578EU" is what someone replacing a part actually
  // types.
  const MAX_TERMS = 8;
  const terms = normalizeForSearch(q).split(/\s+/).filter(Boolean).slice(0, MAX_TERMS);
  const params = {};
  terms.forEach((term, i) => {
    params[`t${i}`] = `%${term}%`;
  });
  const searchClause = terms.length
    ? `${activeClause ? "AND" : "WHERE"} ` +
      terms
        .map((_, i) => `(p.search_text LIKE @t${i} OR c.search_text LIKE @t${i})`)
        .join(" AND ")
    : "";

  // Paging. Optional and off by default, so the storefront search keeps
  // returning every match — but the panel's catalogue tab needs it: on a real
  // client this table holds ~14,500 rows, and pulling all of them (~28 MB, see
  // the note on /count) to render a list nobody scrolls to the end of made that
  // tab unusable as soon as it grew a per-product control.
  const MAX_LIMIT = 500;
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 0, 0), MAX_LIMIT);
  const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);
  const pageClause = limit ? "LIMIT @limit OFFSET @offset" : "";
  if (limit) {
    params.limit = limit;
    params.offset = offset;
  }

  const rows = db
    .prepare(
      `SELECT p.*, c.display_name AS owned_name
         FROM products p
         LEFT JOIN product_content c ON c.sku = p.sku AND c.status = 'owned'
        ${activeClause} ${searchClause}
        ORDER BY p.category, p.name COLLATE NOCASE
        ${pageClause}`,
    )
    .all(params);

  // Our title wins wherever we have one, so a search result card and the
  // product page it links to never disagree about the product's name.
  const products = rows.map(({ owned_name, ...row }) => ({
    ...row,
    name: owned_name || row.name,
    feed_name: row.name,
  }));
  res.json({ products });
});

// GET /api/products/facets — the categories and brands the live catalogue
// actually contains, with a product count each. Feeds the checkbox pickers in
// the panel's shop-front tab, so the client picks from what exists rather than
// typing a slug and hoping.
//
// Aggregated in JS rather than with GROUP BY: neither products.category nor
// products.brand is indexed, so grouping in SQL would scan the table once per
// group. site/_data/shopBlocks.js does the same thing for the same reason.
//
// Public, like /count — every category and brand page it names is already in
// the sitemap.
//
// MUST stay above the /:sku route (see the note on /count).
router.get("/facets", (req, res) => {
  const rows = db
    .prepare("SELECT category, brand FROM products WHERE active = 1 AND feed_active = 1")
    .all();

  const tally = (values) => {
    const counts = new Map();
    for (const value of values) {
      const label = (value || "").trim();
      if (!label) continue;
      counts.set(label, (counts.get(label) || 0) + 1);
    }
    return Array.from(counts, ([label, total]) => ({ label, slug: toSlug(label), total }))
      .filter((f) => f.slug)
      .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label, "es"));
  };

  res.json({
    categories: tally(rows.map((r) => r.category)),
    brands: tally(rows.map((r) => r.brand)),
  });
});

// GET /api/products/count — how many products the site is currently selling.
//
// Exists for the post-deploy smoke test (scripts/smoke-test.sh), which is
// bash + curl only and needs to spot a catalogue that collapsed. Counting via
// GET /api/products would mean pulling ~28 MB on a real client's catalogue on
// every check; this is a few bytes.
//
// Public, and nothing is leaked by it: every one of these products has its own
// crawlable page and they are all listed in the sitemap.
//
// MUST stay above the /:sku route — Express matches in definition order, so
// declared after it, "count" would be read as a SKU.
router.get("/count", (req, res) => {
  const { count } = db
    .prepare("SELECT COUNT(*) AS count FROM products WHERE active = 1 AND feed_active = 1")
    .get();
  res.json({ count });
});

// GET /api/products/:sku — single product by SKU (public, must be active)
router.get("/:sku", (req, res) => {
  const product = db
    .prepare("SELECT * FROM products WHERE sku = ? AND active = 1")
    .get(req.params.sku);
  if (!product) return res.status(404).json({ error: "Producto no encontrado" });
  res.json(product);
});

// PUT /api/products/:id — admin toggles visibility only. Price, stock, name,
// description and category are sync-owned: editing them here would just be
// silently reverted by the next Liderpapel sync.
router.put("/:id", requireAuth, (req, res) => {
  const { active } = req.body;
  const product = db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id);
  if (!product) return res.status(404).json({ error: "Producto no encontrado" });

  db.prepare("UPDATE products SET active = ?, updated_at = datetime('now') WHERE id = ?").run(
    active ? 1 : 0,
    req.params.id,
  );
  scheduleRebuild();

  res.json({
    success: true,
    ...db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id),
  });
});

export default router;
