import { Router } from "express";
import jwt from "jsonwebtoken";
import db, { getConfig } from "../db/database.js";
import { requireAuth } from "../middleware/auth.js";
import { scheduleRebuild } from "../build/rebuild.js";

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
  const activeClause = isAuth ? "" : "WHERE active = 1";
  const searchClause = q ? `${activeClause ? "AND" : "WHERE"} (name LIKE @q OR category LIKE @q)` : "";
  const products = db
    .prepare(
      `SELECT * FROM products ${activeClause} ${searchClause} ORDER BY category, name COLLATE NOCASE`,
    )
    .all(q ? { q: `%${q}%` } : {});
  res.json({ products });
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
