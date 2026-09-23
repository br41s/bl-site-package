import cron from "node-cron";
import { readdir, stat, unlink } from "node:fs/promises";
import { join, basename } from "node:path";
import db from "../db/database.js";
import { UPLOADS_DIR as uploadsDir } from "./uploads-dir.js";

// Only content-hash WebP files produced by optimizeToWebp are ever deletion
// candidates (see src/media/optimize-image.js: 32 hex chars + ".webp"). This
// leaves logo.* and any other unexpected file in data/uploads untouched by
// construction — we never remove something we didn't author.
const HASH_WEBP = /^[a-f0-9]{32}\.webp$/;

// Grace period before an orphan is eligible for deletion. An upload is written
// to disk by POST /api/site/upload-image, then the article/config row that
// references it is saved by a *separate* later request. Between the two, the
// file looks orphaned. Skipping recently-modified files prevents the sweep from
// deleting an upload that is still mid-flow.
const MIN_AGE_MS = 60 * 60 * 1000; // 1 hour

// Daily, off-peak. Orphans (e.g. yesterday's regenerated blog cover, now
// replaced) are reclaimed within a day of becoming unreferenced.
const CLEANUP_SCHEDULE = "30 4 * * *";

// Every /uploads/<name> reference inside a stored string. A value may hold
// MANY: an article body can carry an infographic image, an inline figure and a
// link, so this collects all of them rather than treating the value as a single
// path.
const UPLOAD_REF = /\/uploads\/([A-Za-z0-9][A-Za-z0-9._-]*)/g;

function collectRefs(value, names) {
  if (typeof value !== "string" || !value.includes("/uploads/")) return;
  for (const match of value.matchAll(UPLOAD_REF)) {
    names.add(match[1].split(/[?#]/)[0]);
  }
}

// Every upload filename referenced anywhere in the DB.
//
// This walks EVERY column of every article and EVERY config value, on purpose.
// The previous version listed the fields it knew about — articles.image_url and
// the page_*_image config keys — and that list is what caused the only data loss
// this sweeper has ever produced. The Infographic Engineer writes its artwork
// reference inside articles.content and nowhere else, so every infographic image
// was an orphan by construction: five on one client site were deleted between
// July and September 2026 while all 43 blog covers, which do live in image_url,
// survived. The asymmetry was the fingerprint.
//
// A reference can appear in any text a human or an agent can write, and the set
// of such fields grows. Enumerating them is a bet that nobody adds another one;
// scanning everything is not.
function referencedFilenames() {
  const names = new Set();

  for (const row of db.prepare("SELECT * FROM articles").all()) {
    for (const value of Object.values(row)) collectRefs(value, names);
  }

  for (const { value } of db.prepare("SELECT value FROM config").all()) {
    collectRefs(value, names);
  }

  return names;
}

/**
 * Remove content-hash WebP uploads no longer referenced by any article cover or
 * page-image config value. Idempotent and safe to run any time. Returns
 * { deleted, freedBytes } for observability/tests.
 */
export async function sweepUploads() {
  const referenced = referencedFilenames();

  let entries;
  try {
    entries = await readdir(uploadsDir);
  } catch (err) {
    if (err.code === "ENOENT") return { deleted: 0, freedBytes: 0 };
    throw err;
  }

  const now = Date.now();
  let deleted = 0;
  let freedBytes = 0;

  for (const name of entries) {
    if (!HASH_WEBP.test(name)) continue; // never touch logo.* or foreign files
    if (referenced.has(name)) continue; // still in use somewhere

    const full = join(uploadsDir, name);
    try {
      const info = await stat(full);
      if (now - info.mtimeMs < MIN_AGE_MS) continue; // may be mid-upload
      await unlink(full);
      deleted++;
      freedBytes += info.size;
    } catch (err) {
      if (err.code === "ENOENT") continue; // already gone — fine
      console.error(`cleanup-uploads: no se pudo borrar ${name}:`, err.message);
    }
  }

  if (deleted > 0) {
    console.log(
      `cleanup-uploads: ${deleted} imagen(es) huérfana(s) eliminada(s), ` +
        `${Math.round(freedBytes / 1024)} KB liberados`,
    );
  }
  return { deleted, freedBytes };
}

let started = false;

// Run once on startup (reclaim orphans left while the process was down) then
// daily. Mirrors startLiderpapelScheduler: idempotent, guarded against double
// registration, never lets a sweep error crash the process.
export function startUploadsCleanupScheduler() {
  if (started) return;
  started = true;

  sweepUploads().catch((err) =>
    console.error("cleanup-uploads (inicio):", err.message),
  );

  cron.schedule(CLEANUP_SCHEDULE, () => {
    sweepUploads().catch((err) =>
      console.error("cleanup-uploads (programado):", err.message),
    );
  });
}
