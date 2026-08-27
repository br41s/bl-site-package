import { Router } from "express";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, sep } from "node:path";
import db from "../db/database.js";
import { requireAuth } from "../middleware/auth.js";

// The write path for same-site 301s. An agent submits a proposed old->new
// pair; this file decides whether it is real, never the caller — same split
// as product-content.js: the site owns every fact, the agent only proposes
// prose (here, a pair of paths).
const router = Router();

const __dirname = dirname(fileURLToPath(import.meta.url));
// Overridable the same way DB_PATH is (src/db/database.js) — lets tests point
// this at a throwaway directory instead of the real build output.
const SITE_DIR = resolve(process.env.SITE_DIR || join(__dirname, "../../_site"));
const ALLOWED_TIERS = ["gtin", "mpn", "human"];
const MAX_EVIDENCE_JSON = 5000;

function withinSiteDir(candidate) {
  const resolved = resolve(candidate);
  return resolved === SITE_DIR || resolved.startsWith(SITE_DIR + sep);
}

// Mirrors exactly what `express.static(_site, { extensions: ["html"] })`
// would answer for this path — exact file, then the same path with .html
// appended (our clean-URL routes), then a directory's index.html. Checking
// the built output on disk rather than looping the request back through HTTP
// is what lets this answer be trusted without a live network round trip.
export function resolvesOnDisk(urlPath) {
  const clean = String(urlPath || "").split(/[?#]/)[0].replace(/\/+$/, "") || "/";
  const rel = clean === "/" ? "index.html" : clean.replace(/^\/+/, "");
  const candidates = [join(SITE_DIR, rel), join(SITE_DIR, `${rel}.html`), join(SITE_DIR, rel, "index.html")];
  return candidates.some((p) => withinSiteDir(p) && existsSync(p));
}

// Consulted by the request-time middleware in src/server.js, on every
// request, before the static mount. Only a 'live' row is ever returned — a
// 'pending' proposal must stay invisible to visitors until it is approved.
export function findLiveRedirect(oldPath) {
  return db.prepare("SELECT * FROM redirects WHERE old_path = ? AND status = 'live'").get(oldPath);
}

router.get("/", requireAuth, (req, res) => {
  const status = ["pending", "live"].includes(req.query.status) ? req.query.status : null;
  const rows = status
    ? db.prepare("SELECT * FROM redirects WHERE status = ? ORDER BY updated_at DESC").all(status)
    : db.prepare("SELECT * FROM redirects ORDER BY updated_at DESC").all();
  res.json({ redirects: rows });
});

// POST / — propose a redirect. Always lands as 'pending', however strong the
// evidence: publishing is a separate, explicit step (POST /:id/publish).
router.post("/", requireAuth, (req, res) => {
  const { old_path, new_path, match_tier, evidence } = req.body || {};

  if (!old_path || !new_path) {
    return res.status(400).json({ error: "old_path y new_path son obligatorios" });
  }
  if (!old_path.startsWith("/") || !new_path.startsWith("/")) {
    return res.status(400).json({ error: "old_path y new_path deben empezar por /" });
  }
  if (old_path === new_path) {
    return res.status(400).json({ error: "old_path y new_path no pueden ser la misma ruta" });
  }

  const tier = ALLOWED_TIERS.includes(match_tier) ? match_tier : "human";
  const blockers = [];

  // The server re-checks both ends itself rather than trusting whatever the
  // caller saw on an earlier HTTP probe, which may already be stale by the
  // time this request lands.
  if (resolvesOnDisk(old_path)) {
    blockers.push("old_path todavía resuelve en el sitio construido — no está muerta");
  }
  if (!resolvesOnDisk(new_path)) {
    blockers.push("new_path no resuelve en el sitio construido ahora mismo");
  }
  if (db.prepare("SELECT 1 FROM redirects WHERE old_path = ?").get(new_path)) {
    blockers.push("new_path es ya el origen de otra redirección — evitaría una cadena");
  }

  // An identifier-tier claim is re-derived here, never trusted from the
  // evidence blob — the whole point of a checkable tier is that it IS
  // checked, the same invariant product-content.js applies to gtin/mpn.
  if (tier === "gtin" || tier === "mpn") {
    const slug = new_path.replace(/^\/productos\//, "").replace(/\.html$/, "");
    const product = db.prepare("SELECT * FROM products WHERE slug = ?").get(slug);
    if (!product) {
      blockers.push(`no se encontró un producto con slug '${slug}' bajo new_path`);
    } else {
      const claimed = evidence && typeof evidence === "object" ? evidence[tier] : null;
      const actual = tier === "gtin" ? product.gtin : product.mpn;
      if (!claimed || !actual || String(claimed) !== String(actual)) {
        blockers.push(`el ${tier} en evidence no coincide con el del producto de destino`);
      }
    }
  }

  if (blockers.length > 0) {
    return res.status(422).json({ error: "La redirección no pasa la validación", blockers });
  }

  const evidenceJson = evidence ? JSON.stringify(evidence).slice(0, MAX_EVIDENCE_JSON) : null;
  db.prepare(
    `INSERT INTO redirects (old_path, new_path, status, match_tier, evidence)
     VALUES (@old_path, @new_path, 'pending', @tier, @evidence)
     ON CONFLICT(old_path) DO UPDATE SET
       new_path = excluded.new_path,
       status = 'pending',
       match_tier = excluded.match_tier,
       evidence = excluded.evidence,
       updated_at = datetime('now')`,
  ).run({ old_path, new_path, tier, evidence: evidenceJson });

  res.json({
    success: true,
    ...db.prepare("SELECT * FROM redirects WHERE old_path = ?").get(old_path),
  });
});

// POST /:id/publish — the one call that makes a redirect real. Re-validates
// new_path at the moment of publishing, not at the (possibly much earlier)
// moment it was proposed — the site may have changed in between.
router.post("/:id/publish", requireAuth, (req, res) => {
  const row = db.prepare("SELECT * FROM redirects WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Redirección no encontrada" });

  if (!resolvesOnDisk(row.new_path)) {
    return res.status(422).json({
      error: "No se puede publicar",
      blockers: ["new_path ya no resuelve en el sitio construido"],
    });
  }

  db.prepare("UPDATE redirects SET status = 'live', updated_at = datetime('now') WHERE id = ?").run(row.id);
  res.json({ success: true, ...db.prepare("SELECT * FROM redirects WHERE id = ?").get(row.id) });
});

router.delete("/:id", requireAuth, (req, res) => {
  const result = db.prepare("DELETE FROM redirects WHERE id = ?").run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: "Redirección no encontrada" });
  res.json({ success: true });
});

export default router;
