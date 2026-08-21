import { Router } from "express";
import jwt from "jsonwebtoken";
import db, { getConfig } from "../db/database.js";
import { requireAuth } from "../middleware/auth.js";
import { scheduleRebuild } from "../build/rebuild.js";
import { normalizeForSearch } from "../utils/text.js";

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

  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const activeClause = isAuth ? "" : "WHERE p.active = 1";
  // Search both the distributor's wording and our own. A rewritten sheet is
  // displayed under the title we gave it, so searching for what is on screen
  // has to work — before this, the one title a visitor could see was the one
  // title they could not find. Identifiers ride along in p.search_text, put
  // there by the sync, because "2104578EU" is what someone replacing a part
  // actually types.
  const searchClause = q
    ? `${activeClause ? "AND" : "WHERE"} (p.search_text LIKE @q OR c.search_text LIKE @q)`
    : "";

  const rows = db
    .prepare(
      `SELECT p.*, c.display_name AS owned_name
         FROM products p
         LEFT JOIN product_content c ON c.sku = p.sku AND c.status = 'owned'
        ${activeClause} ${searchClause}
        ORDER BY p.category, p.name COLLATE NOCASE`,
    )
    .all(q ? { q: `%${normalizeForSearch(q)}%` } : {});

  // Our title wins wherever we have one, so a search result card and the
  // product page it links to never disagree about the product's name.
  const products = rows.map(({ owned_name, ...row }) => ({
    ...row,
    name: owned_name || row.name,
    feed_name: row.name,
  }));
  res.json({ products });
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
