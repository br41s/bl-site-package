import cron from "node-cron";
import { readdir, stat, unlink } from "node:fs/promises";
import { join, basename } from "node:path";
import db, { getConfig, PUBLIC_CONFIG_KEYS } from "../db/database.js";
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

// If a stored value points at /uploads/<name>, return that <name>; else null.
// Article covers and page images always store an /uploads/*.webp path. External
// URLs (e.g. Liderpapel product images) don't contain /uploads/ and are ignored.
function uploadFilename(value) {
  if (typeof value !== "string" || !value.includes("/uploads/")) return null;
  return basename(value.split(/[?#]/)[0]);
}

// Every upload filename currently referenced by the DB: blog covers
// (articles.image_url) plus page hero images (page_*_image config keys). A file
// is safe to delete only if it appears in none of these, so a hash shared by
// several rows is kept as long as any one row still points at it.
function referencedFilenames() {
  const names = new Set();

  const rows = db
    .prepare("SELECT image_url FROM articles WHERE image_url IS NOT NULL AND image_url != ''")
    .all();
  for (const { image_url } of rows) {
    const name = uploadFilename(image_url);
    if (name) names.add(name);
  }

  for (const key of PUBLIC_CONFIG_KEYS) {
    // page_*_image, but not the sibling page_*_image_alt (alt text, not a path).
    if (key.startsWith("page_") && key.endsWith("_image")) {
      const name = uploadFilename(getConfig(key));
      if (name) names.add(name);
    }
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
