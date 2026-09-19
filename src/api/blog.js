import { Router } from "express";
import jwt from "jsonwebtoken";
import { verifyJWT } from "../middleware/auth.js";
import db, { getConfig } from "../db/database.js";
import { hashContent } from "../utils/text.js";
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

// Cap on the agent's evidence ledger, mirroring redirects.js. A proposal is
// meant to carry the handful of sources behind the claims it changes, not a
// research dump.
const MAX_EVIDENCE_JSON = 5000;
const EDIT_FIELDS = ["title", "content", "excerpt"];
// Revisions kept per article. A row holds a full article body — call it 2-8 KB
// — and on a site running the content updater, the infographic engineer and the
// maintenance agent, the same post can collect several a month forever. The
// listing endpoint only ever returns 50, so anything past that was already
// unreachable; this stops it also being unbounded weight in a client's SQLite
// file and in every backup of it.
const REVISIONS_KEPT = 50;

// Store the article's CURRENT state before something replaces it.
//
// Must be called inside the same transaction as the write it precedes. On its
// own it is not a safety feature: a snapshot that commits while the update
// that supersedes it rolls back describes a replacement that never happened,
// which is worse than having no history, because someone would trust it.
//
// `author` is a self-declared label, not an identity. Every agent on a rented
// site authenticates with the same panel password, so the server cannot tell
// them apart and does not pretend to. It is here so a human reading the list
// can see "content-updater" and go look at that agent's report — never for an
// authorization decision.
function snapshotRevision(articleId, author) {
  const current = db.prepare("SELECT * FROM articles WHERE id = ?").get(articleId);
  if (!current) return null;
  db.prepare(
    `INSERT INTO article_revisions (article_id, title, content, excerpt, content_hash, author)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    articleId,
    current.title,
    current.content,
    current.excerpt,
    current.content_hash || hashContent(current.content),
    author || null,
  );
  // Trim in the same transaction as the insert, so the cap is a property of
  // the table rather than a job someone has to remember to run.
  db.prepare(
    `DELETE FROM article_revisions
      WHERE article_id = ?
        AND id NOT IN (
          SELECT id FROM article_revisions
           WHERE article_id = ? ORDER BY id DESC LIMIT ?
        )`,
  ).run(articleId, articleId, REVISIONS_KEPT);
  return current;
}

// The live fingerprint of an article, falling back to computing it for rows
// written before the column existed (the backfill in database.js covers rows
// present at upgrade time; this covers anything that slipped past).
function liveHash(article) {
  return article.content_hash || hashContent(article.content);
}

function readAuthor(req) {
  const raw = req.body?.author;
  return typeof raw === "string" && raw.trim() ? raw.trim().slice(0, 80) : null;
}

// Reject an evidence ledger that isn't storable. Returns the string to store,
// or throws a message for the 400.
function normalizeEvidence(evidence) {
  if (evidence === undefined || evidence === null) return null;
  const json = typeof evidence === "string" ? evidence : JSON.stringify(evidence);
  if (json.length > MAX_EVIDENCE_JSON)
    throw new Error(`evidence supera ${MAX_EVIDENCE_JSON} caracteres`);
  try {
    JSON.parse(json);
  } catch {
    throw new Error("evidence debe ser JSON válido");
  }
  return json;
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
  const { title, content, excerpt, status = "draft", cta_url, cta_label, image_url, image_alt, badges } = req.body;
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
      "INSERT INTO articles (title, slug, content, excerpt, status, cta_url, cta_label, image_url, image_alt, badges, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(title, slug, content, excerpt || "", status, cta_url || null, cta_label || null, image_url || null, image_alt || null, badges || null, hashContent(content));

  const article = db
    .prepare("SELECT * FROM articles WHERE id = ?")
    .get(result.lastInsertRowid);
  scheduleRebuild();
  res.status(201).json({ success: true, id: article.id, ...article });
});

// PUT /api/blog/posts/:id — update
//
// Unchanged for every existing caller: the panel, the infographic engineer and
// the maintenance agent all keep working exactly as before. Two things now
// happen around the write.
//
// `base_hash` is OPTIONAL and enforced only when sent. Making it mandatory
// would have been the stricter design and the wrong one — it would break every
// current writer on the day of the upgrade to protect them from a collision
// they mostly do not have. An agent that sends it gets the guard; one that does
// not is exactly where it was.
//
// A revision is taken unconditionally, because the caller who most needs an
// undo is precisely the one who did not think to ask for one.
router.put("/posts/:id", verifyJWT, (req, res) => {
  const { title, content, excerpt, status, cta_url, cta_label, image_url, image_alt, badges, base_hash } = req.body;
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
  if (base_hash && base_hash !== liveHash(article)) {
    return res.status(409).json({
      error:
        "El artículo ha cambiado desde que lo leíste. Vuelve a leerlo y reescribe el cambio sobre la versión actual.",
      current_hash: liveHash(article),
    });
  }

  const author = readAuthor(req);
  const apply = db.transaction(() => {
    snapshotRevision(article.id, author);
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
        badges = COALESCE(?, badges),
        updated_at = datetime('now')
      WHERE id = ?`,
    ).run(title, content, excerpt, status, cta_url, cta_label, image_url, image_alt, badges, req.params.id);
    // Recomputed from what actually landed, not from the request: COALESCE
    // means a caller who sent no content still has its old body, and hashing
    // the request would fingerprint a body that is not there.
    const after = db.prepare("SELECT content FROM articles WHERE id = ?").get(req.params.id);
    db.prepare("UPDATE articles SET content_hash = ? WHERE id = ?").run(
      hashContent(after.content),
      req.params.id,
    );
  });
  apply();

  scheduleRebuild();
  res.json({
    success: true,
    ...db.prepare("SELECT * FROM articles WHERE id = ?").get(req.params.id),
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Revisions and proposed edits.
//
// Everything above this line serves agents that ADD: a post that did not
// exist, a block inserted into one. The content updater is the first agent
// whose whole job is changing prose that is already live and already correct,
// and for that "last writer wins, no undo, no review" stops being tolerable.
//
// The shape is taken from redirects.js, which solved the same problem for
// paths: a proposal always lands pending however good its evidence, the
// server re-checks at apply time rather than trusting what the caller
// asserted when it wrote, and publishing is a separate explicit call.
// ─────────────────────────────────────────────────────────────────────────

// GET /api/blog/posts/:id/revisions — what this article used to say.
router.get("/posts/:id/revisions", verifyJWT, (req, res) => {
  const article = db.prepare("SELECT id FROM articles WHERE id = ?").get(req.params.id);
  if (!article) return res.status(404).json({ error: "Artículo no encontrado" });
  const revisions = db
    .prepare(
      `SELECT id, article_id, title, excerpt, content_hash, author, created_at
       FROM article_revisions WHERE article_id = ? ORDER BY id DESC LIMIT 50`,
    )
    .all(req.params.id);
  res.json({ revisions });
});

// GET /api/blog/revisions/:id — one revision, body included.
// Split from the list above so listing the history of a long article stays
// cheap; a panel showing 50 rows does not want 50 article bodies.
router.get("/revisions/:id", verifyJWT, (req, res) => {
  const revision = db.prepare("SELECT * FROM article_revisions WHERE id = ?").get(req.params.id);
  if (!revision) return res.status(404).json({ error: "Revisión no encontrada" });
  res.json(revision);
});

// POST /api/blog/posts/:id/revert — restore a previous revision.
//
// Itself snapshotted, so an accidental revert is as recoverable as the edit
// that prompted it. A one-way undo is a second way to lose the text.
router.post("/posts/:id/revert", verifyJWT, (req, res) => {
  const { revision_id } = req.body || {};
  const article = db.prepare("SELECT * FROM articles WHERE id = ?").get(req.params.id);
  if (!article) return res.status(404).json({ error: "Artículo no encontrado" });

  const revision = revision_id
    ? db.prepare("SELECT * FROM article_revisions WHERE id = ?").get(revision_id)
    : db
        .prepare("SELECT * FROM article_revisions WHERE article_id = ? ORDER BY id DESC LIMIT 1")
        .get(req.params.id);
  if (!revision) return res.status(404).json({ error: "Revisión no encontrada" });
  if (revision.article_id !== article.id)
    return res.status(400).json({ error: "Esa revisión pertenece a otro artículo" });

  const author = readAuthor(req);
  const apply = db.transaction(() => {
    snapshotRevision(article.id, author || "revert");
    db.prepare(
      `UPDATE articles SET title = ?, content = ?, excerpt = ?, content_hash = ?,
         updated_at = datetime('now') WHERE id = ?`,
    ).run(
      revision.title,
      revision.content,
      revision.excerpt,
      hashContent(revision.content),
      article.id,
    );
  });
  apply();

  scheduleRebuild();
  res.json({
    success: true,
    reverted_to: revision.id,
    ...db.prepare("SELECT * FROM articles WHERE id = ?").get(article.id),
  });
});

// POST /api/blog/posts/:id/propose — submit a rewrite for a human to approve.
//
// base_hash is REQUIRED here, unlike on PUT. A proposal sits in the queue for
// as long as it takes someone to read it, which is exactly the window in which
// another agent or the client edits the same article — so a proposal that
// cannot say which version it was written against cannot be applied safely at
// any later point, and there is no existing caller to keep working.
router.post("/posts/:id/propose", verifyJWT, (req, res) => {
  const { title, content, excerpt, reason, evidence, base_hash } = req.body || {};
  const article = db.prepare("SELECT * FROM articles WHERE id = ?").get(req.params.id);
  if (!article) return res.status(404).json({ error: "Artículo no encontrado" });

  if (!title && !content && !excerpt)
    return res.status(400).json({ error: "Nada que proponer: envía title, content o excerpt" });
  if (!base_hash)
    return res.status(400).json({ error: "base_hash es obligatorio (el content_hash del artículo que leíste)" });
  if (base_hash !== liveHash(article))
    return res.status(409).json({
      error: "El artículo ha cambiado desde que lo leíste. Vuelve a leerlo antes de proponer.",
      current_hash: liveHash(article),
    });

  let evidenceJson;
  try {
    evidenceJson = normalizeEvidence(evidence);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const result = db
    .prepare(
      `INSERT INTO article_edits (article_id, title, content, excerpt, reason, evidence, base_hash, author)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      article.id,
      title || null,
      content || null,
      excerpt || null,
      reason || null,
      evidenceJson,
      base_hash,
      readAuthor(req),
    );

  res.status(201).json({
    success: true,
    id: result.lastInsertRowid,
    status: "pending",
    message: "Propuesta guardada. No es visible en la web hasta que alguien la aprueba.",
  });
});

// GET /api/blog/edits — the review queue.
router.get("/edits", verifyJWT, (req, res) => {
  const status = ["pending", "applied", "rejected"].includes(req.query.status)
    ? req.query.status
    : null;
  const rows = status
    ? db
        .prepare("SELECT * FROM article_edits WHERE status = ? ORDER BY updated_at DESC")
        .all(status)
    : db.prepare("SELECT * FROM article_edits ORDER BY updated_at DESC").all();
  // Joined here rather than left to the caller: a queue that shows an id and
  // no title is a queue nobody reviews.
  const titled = rows.map((row) => ({
    ...row,
    article_title: db.prepare("SELECT title FROM articles WHERE id = ?").get(row.article_id)?.title || null,
  }));
  res.json({ edits: titled });
});

// POST /api/blog/edits/:id/apply — approve a proposal and publish it.
//
// The base_hash is re-checked HERE, against the article as it is right now,
// not as it was when the proposal was written. That re-check is the whole
// point of the split: the proposal was valid when submitted, and the only
// question that matters is whether it is still valid now.
router.post("/edits/:id/apply", verifyJWT, (req, res) => {
  const edit = db.prepare("SELECT * FROM article_edits WHERE id = ?").get(req.params.id);
  if (!edit) return res.status(404).json({ error: "Propuesta no encontrada" });
  if (edit.status !== "pending")
    return res.status(409).json({ error: `La propuesta ya está en estado '${edit.status}'` });

  const article = db.prepare("SELECT * FROM articles WHERE id = ?").get(edit.article_id);
  if (!article) return res.status(404).json({ error: "El artículo ya no existe" });

  if (edit.base_hash !== liveHash(article)) {
    // Left pending on purpose. Refusing to apply is not the same as deciding
    // the proposal was wrong — the content of it may still be exactly right,
    // and that is a judgement for the person reading it, not for this check.
    return res.status(409).json({
      error:
        "El artículo ha cambiado desde que se redactó la propuesta. Revísala contra la versión actual antes de aplicarla.",
      current_hash: liveHash(article),
      proposal_base_hash: edit.base_hash,
    });
  }

  const apply = db.transaction(() => {
    snapshotRevision(article.id, edit.author || "article_edit");
    db.prepare(
      `UPDATE articles SET
        title = COALESCE(?, title),
        content = COALESCE(?, content),
        excerpt = COALESCE(?, excerpt),
        updated_at = datetime('now')
      WHERE id = ?`,
    ).run(edit.title, edit.content, edit.excerpt, article.id);
    const after = db.prepare("SELECT content FROM articles WHERE id = ?").get(article.id);
    db.prepare("UPDATE articles SET content_hash = ? WHERE id = ?").run(
      hashContent(after.content),
      article.id,
    );
    db.prepare(
      "UPDATE article_edits SET status = 'applied', updated_at = datetime('now') WHERE id = ?",
    ).run(edit.id);
  });
  apply();

  scheduleRebuild();
  res.json({
    success: true,
    ...db.prepare("SELECT * FROM articles WHERE id = ?").get(article.id),
  });
});

// POST /api/blog/edits/:id/reject
router.post("/edits/:id/reject", verifyJWT, (req, res) => {
  const edit = db.prepare("SELECT * FROM article_edits WHERE id = ?").get(req.params.id);
  if (!edit) return res.status(404).json({ error: "Propuesta no encontrada" });
  if (edit.status !== "pending")
    return res.status(409).json({ error: `La propuesta ya está en estado '${edit.status}'` });

  const note = typeof req.body?.reason === "string" ? req.body.reason.slice(0, 500) : null;
  db.prepare(
    `UPDATE article_edits SET status = 'rejected',
       reason = COALESCE(?, reason), updated_at = datetime('now') WHERE id = ?`,
  ).run(note, edit.id);
  res.json({ success: true, id: edit.id, status: "rejected" });
});

// DELETE /api/blog/posts/:id
//
// Takes the article's history with it, in one transaction.
//
// Not housekeeping: a revision row holds the FULL body of the article it
// snapshotted, so leaving them behind means "delete" does not delete. The text
// a client removed — because it was wrong, or because someone asked them to
// take it down — would stay readable through GET /api/blog/revisions/:id for
// the life of the site. Orphan rows also have nothing to be restored onto,
// since revert resolves through the article, so they are pure weight.
router.delete("/posts/:id", verifyJWT, (req, res) => {
  const article = db.prepare("SELECT id FROM articles WHERE id = ?").get(req.params.id);
  if (!article) return res.status(404).json({ error: "Artículo no encontrado" });

  const remove = db.transaction(() => {
    db.prepare("DELETE FROM article_revisions WHERE article_id = ?").run(article.id);
    db.prepare("DELETE FROM article_edits WHERE article_id = ?").run(article.id);
    db.prepare("DELETE FROM articles WHERE id = ?").run(article.id);
  });
  remove();

  scheduleRebuild();
  res.json({ success: true });
});

export default router;
