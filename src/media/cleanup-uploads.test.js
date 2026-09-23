import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// This sweeper is the only thing in the package that DELETES a client's files,
// and until 2026-09-23 it had no test at all. It also produced the only data
// loss it has ever been involved in: referencedFilenames() listed the fields it
// knew about — articles.image_url and the page_*_image config keys — so an image
// referenced only inside articles.content looked orphaned. Five infographics on
// one client site were deleted between July and September 2026 while all 43 blog
// covers survived, because covers live in image_url and infographics do not.
// That asymmetry was the fingerprint, and the fixture below reproduces it.

// database.js and uploads-dir.js both resolve their paths at import time, so
// both env vars have to be set before anything imports them.
const ROOT = mkdtempSync(join(tmpdir(), "bl-cleanup-"));
const UPLOADS = mkdtempSync(join(tmpdir(), "bl-uploads-"));
process.env.DB_PATH = join(ROOT, "app.db");
process.env.UPLOADS_DIR = UPLOADS;
process.env.BL_SITE_DISABLE_REBUILD = "1";

const db = (await import("../db/database.js")).default;
const { sweepUploads } = await import("./cleanup-uploads.js");

const hash = (n) => String(n).padStart(32, "0").replace(/0/g, "a").slice(0, 31) + n + ".webp";
const COVER = hash(1), INFOGRAPHIC = hash(2), ORPHAN = hash(3), PAGE_IMAGE = hash(4);

function aged(name) {
  const p = join(UPLOADS, name);
  writeFileSync(p, "x");
  const old = Date.now() / 1000 - 7 * 24 * 3600;      // past the 1h grace window
  utimesSync(p, old, old);
}

before(() => {
  for (const f of [COVER, INFOGRAPHIC, ORPHAN, PAGE_IMAGE]) aged(f);
  db.prepare("DELETE FROM articles").run();
  db.prepare(
    "INSERT INTO articles (title, slug, content, excerpt, image_url, status) VALUES (?,?,?,?,?,?)",
  ).run(
    "Con infografía",
    "con-infografia",
    `Texto.\n\n<figure class="article-infographic article-infographic--poster">` +
      `<img src="/uploads/${INFOGRAPHIC}" alt="" width="800" height="1200"></figure>\n\nMás texto.`,
    null,
    `/uploads/${COVER}`,
    "published",
  );
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?,?)")
    .run("page_index_image", `/uploads/${PAGE_IMAGE}`);
});

describe("cleanup-uploads reference scanning", () => {
  test("keeps an image referenced only inside articles.content", async () => {
    await sweepUploads();
    const left = readdirSync(UPLOADS);

    assert.ok(
      left.includes(INFOGRAPHIC),
      "an image referenced only in articles.content was deleted — this is the July 2026 bug",
    );
    assert.ok(left.includes(COVER), "the cover in image_url was deleted");
    assert.ok(left.includes(PAGE_IMAGE), "the page_*_image config value was deleted");
    assert.ok(
      !left.includes(ORPHAN),
      "a genuinely unreferenced upload survived — the sweeper has become a no-op, " +
        "which is the other way this test can fail usefully",
    );
  });

  test("keeps every reference when one body carries several", async () => {
    const a = hash(5), b = hash(6);
    for (const f of [a, b]) aged(f);
    db.prepare("UPDATE articles SET content = ? WHERE slug = ?").run(
      `<img src="/uploads/${a}"> y <img src="/uploads/${b}?v=2"> y /uploads/${INFOGRAPHIC}`,
      "con-infografia",
    );
    await sweepUploads();
    const left = readdirSync(UPLOADS);
    assert.ok(left.includes(a) && left.includes(b), "a body with two references lost one");
    assert.ok(left.includes(INFOGRAPHIC), "a bare path reference was not recognised");
  });
});
