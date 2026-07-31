import { Router } from "express";
import jwt from "jsonwebtoken";
import { verifyJWT } from "../middleware/auth.js";
import db, { getConfig } from "../db/database.js";
import { scheduleRebuild } from "../build/rebuild.js";

const router = Router();

function generateSlug(title) {
  return title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

// Is this request carrying a valid panel JWT? Read-only routes use this to
// decide whether drafts are visible; it never rejects on its own (unlike
// verifyJWT), because an anonymous caller is legitimate here — it just sees
// less. Accepts the token as a Bearer header or the panel's x-panel-token.
function isAuthenticated(req) {
  const authHeader = req.headers["authorization"];
  const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const panelToken = req.headers["x-panel-token"];
  const token = bearer || (typeof panelToken === "string" ? panelToken : null);
  if (!token) return false;

  const secret = process.env.JWT_SECRET || getConfig("jwt_secret");
  if (!secret) return false;
  try {
    jwt.verify(token, secret);
    return true;
  } catch {
    return false;
  }
}

// GET /api/blog/posts — list (public: only published; authenticated: all)
router.get("/posts", (req, res) => {
  const isAuth = isAuthenticated(req);

  const articles = isAuth
    ? db.prepare("SELECT * FROM articles ORDER BY created_at DESC").all()
    : db
        .prepare(
          "SELECT * FROM articles WHERE status = 'published' ORDER BY created_at DESC",
        )
        .all();
  res.json({ posts: articles });
});

// GET /api/blog/posts/:slug — single article by slug or id
// (public: published only; authenticated: drafts too)
router.get("/posts/:slug", (req, res) => {
  const article = db
    .prepare("SELECT * FROM articles WHERE slug = ? OR id = ?")
    .get(req.params.slug, req.params.slug);
  // Drafts are only for the panel and the client's own rented agents. Slugs
  // are generated from titles and so are guessable, which previously made
  // every unpublished post world-readable. An anonymous caller gets the same
  // 404 as a slug that doesn't exist, so the response never confirms that a
  // hidden post is there.
  if (!article || (article.status !== "published" && !isAuthenticated(req)))
    return res.status(404).json({ error: "Artículo no encontrado" });
  res.json(article);
});

// POST /api/blog/posts — create
router.post("/posts", verifyJWT, (req, res) => {
  const { title, content, excerpt, status = "draft", cta_url, cta_label, image_url, image_alt } = req.body;
  if (!title || !content)
    return res.status(400).json({ error: "Título y contenido requeridos" });
  if (cta_url) {
    try {
      new URL(cta_url);
    } catch {
      return res.status(400).json({ error: "cta_url no es una URL válida" });
    }
  }

  let slug = generateSlug(title);
  let suffix = 0;
  while (
    db
      .prepare("SELECT id FROM articles WHERE slug = ?")
      .get(slug + (suffix ? `-${suffix}` : ""))
  ) {
    suffix++;
  }
  if (suffix) slug = `${slug}-${suffix}`;

  const result = db
    .prepare(
      "INSERT INTO articles (title, slug, content, excerpt, status, cta_url, cta_label, image_url, image_alt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(title, slug, content, excerpt || "", status, cta_url || null, cta_label || null, image_url || null, image_alt || null);

  const article = db
    .prepare("SELECT * FROM articles WHERE id = ?")
    .get(result.lastInsertRowid);
  scheduleRebuild();
  res.status(201).json({ success: true, id: article.id, ...article });
});

// PUT /api/blog/posts/:id — update
router.put("/posts/:id", verifyJWT, (req, res) => {
  const { title, content, excerpt, status, cta_url, cta_label, image_url, image_alt } = req.body;
  const article = db
    .prepare("SELECT * FROM articles WHERE id = ?")
    .get(req.params.id);
  if (!article)
    return res.status(404).json({ error: "Artículo no encontrado" });
  if (cta_url) {
    try {
      new URL(cta_url);
    } catch {
      return res.status(400).json({ error: "cta_url no es una URL válida" });
    }
  }

  db.prepare(
    `UPDATE articles SET
      title = COALESCE(?, title),
      content = COALESCE(?, content),
      excerpt = COALESCE(?, excerpt),
      status = COALESCE(?, status),
      cta_url = COALESCE(?, cta_url),
      cta_label = COALESCE(?, cta_label),
      image_url = COALESCE(?, image_url),
      image_alt = COALESCE(?, image_alt),
      updated_at = datetime('now')
    WHERE id = ?`,
  ).run(title, content, excerpt, status, cta_url, cta_label, image_url, image_alt, req.params.id);

  scheduleRebuild();
  res.json({
    success: true,
    ...db.prepare("SELECT * FROM articles WHERE id = ?").get(req.params.id),
  });
});

// DELETE /api/blog/posts/:id
router.delete("/posts/:id", verifyJWT, (req, res) => {
  const result = db
    .prepare("DELETE FROM articles WHERE id = ?")
    .run(req.params.id);
  if (result.changes === 0)
    return res.status(404).json({ error: "Artículo no encontrado" });
  scheduleRebuild();
  res.json({ success: true });
});

export default router;
