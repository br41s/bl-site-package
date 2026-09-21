// The site keeps answering while it regenerates.
//
// A publish schedules a full Eleventy build of the catalogue (~14,500 product
// pages for a distributor-fed client, ~30s on their host). That build used to
// run inside the server's own process, and the event loop answered nothing
// until it was done: every request that arrived in the window — the agent's
// next read, the panel, a visitor's page — hung for the whole build. The
// agent's client timed out at 30s and retried, 10-23 times a day.
//
// This suite runs a REAL Eleventy build (no BL_SITE_DISABLE_REBUILD) and
// proves a request is served while it is in flight. It therefore writes the
// repo's _site/ from this suite's throwaway database, and Eleventy never
// deletes output, so its product pages linger there on a developer's machine
// until _site/ is cleared. _site/ is build output and every server boot
// regenerates it, so that is cosmetic.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// database.js resolves DB_PATH at import time and refuses to start if it lands
// in a served directory, so point it at a throwaway dir before anything that
// imports it is loaded. The build inherits it, so the child renders this
// database, not the developer's.
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "bl-site-rebuild-")), "app.db");

const express = (await import("express")).default;
const db = (await import("../db/database.js")).default;
const { scheduleRebuild, getBuildState } = await import("./rebuild.js");

const root = join(import.meta.dirname, "../..");

// Enough product pages that the build is CPU-bound for about a second, which
// is what starved the event loop in-process. A dozen static pages finish
// before the request would notice; more than this only slows the suite.
const PRODUCTS = 600;

let server;
let baseUrl;

before(async () => {
  const insert = db.prepare(
    `INSERT INTO products (sku, slug, name, description, category, search_text, price_cents, stock_qty, source_fingerprint)
     VALUES (?, ?, ?, ?, 'Pruebas', '', 100, 1, 'fp')`,
  );
  db.transaction(() => {
    for (let i = 1; i <= PRODUCTS; i++) {
      insert.run(String(i), `${i}-producto`, `Producto ${i}`, `Descripción ${i}.`);
    }
  })();

  const app = express();
  app.get("/ping", (req, res) => res.json({ ok: true }));
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  db.close();
});

// Which slot _site points at, or null before the first build ever completes.
function liveSlot() {
  try {
    return readlinkSync(join(root, "_site"));
  } catch {
    return null;
  }
}

async function until(predicate, what, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("rebuild", () => {
  test("serves an HTTP request while an Eleventy build is in flight", async () => {
    assert.equal(getBuildState().building, false);
    const slotBefore = liveSlot();

    scheduleRebuild(0);
    await until(() => getBuildState().building, "the build to start");
    const buildStartedAt = Date.now();

    const requestStartedAt = Date.now();
    const res = await fetch(`${baseUrl}/ping`);
    const requestMs = Date.now() - requestStartedAt;

    assert.equal(res.status, 200);
    assert.equal(
      getBuildState().building,
      true,
      "the request should be answered before the build finishes",
    );

    await until(() => !getBuildState().building, "the build to finish");
    const buildMs = Date.now() - buildStartedAt;
    const state = getBuildState();
    assert.equal(state.ok, true, "the build itself should succeed");
    assert.ok(state.at, "a finished build records its time");
    // Served through the symlink, which the build repointed only once the
    // slot was complete — and never at the slot that was being served.
    assert.ok(lstatSync(join(root, "_site")).isSymbolicLink(), "_site is a symlink");
    assert.notEqual(liveSlot(), slotBefore);
    assert.ok(
      existsSync(join(root, "_site", "productos", `${PRODUCTS}-producto.html`)),
      "the build rendered the product pages it was seeded with",
    );

    // In-process, the request took as long as the build had left to run
    // (measured: 1357ms of a 1368ms build). Out of process it takes
    // milliseconds, whatever the build takes; half is a loose bound so a busy
    // CI runner does not fail it.
    assert.ok(
      requestMs < buildMs / 2,
      `request took ${requestMs}ms during a ${buildMs}ms build`,
    );
  });

  test("publishes during a build coalesce into exactly one more build", async () => {
    const previous = getBuildState().at;
    const slotBefore = liveSlot();
    scheduleRebuild(0);
    await until(() => getBuildState().building, "the build to start");

    // Several writes while building coalesce into a single follow-up build.
    scheduleRebuild(0);
    scheduleRebuild(0);
    scheduleRebuild(0);

    // The queued build starts the instant the first one ends, so "building"
    // never reads false in between; count finished builds by their timestamps
    // instead, and keep watching a little longer to catch any third one.
    const finished = new Set();
    const deadline = Date.now() + 60_000;
    let quietSince = null;
    while (Date.now() < deadline) {
      const { at, building } = getBuildState();
      if (at && at !== previous) finished.add(at);
      if (!building && quietSince === null) quietSince = Date.now();
      if (building) quietSince = null;
      if (quietSince !== null && Date.now() - quietSince > 500) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.equal(getBuildState().building, false);
    assert.equal(finished.size, 2, `builds finished: ${[...finished].join(", ")}`);
    // Two builds, two flips: consecutive builds alternate slots, so the one
    // being served is never the one being written.
    assert.equal(liveSlot(), slotBefore);
  });

  test("a failed build reports ok=false and does not block the next one", async () => {
    // The child inherits the environment at spawn time, so a Node option
    // that NODE_OPTIONS refuses makes it exit 9 before Eleventy loads — a
    // failure with no database or filesystem side effects.
    const previous = getBuildState().at;
    process.env.NODE_OPTIONS = "--nonexistent-option";
    try {
      scheduleRebuild(0);
      await until(() => getBuildState().building, "the failing build to start");
    } finally {
      delete process.env.NODE_OPTIONS;
    }
    // Queued behind the failing build; spawned after it, with a clean env.
    scheduleRebuild(0);

    const results = new Map();
    const deadline = Date.now() + 60_000;
    let quietSince = null;
    while (Date.now() < deadline) {
      const { at, ok, building } = getBuildState();
      if (at && at !== previous) results.set(at, ok);
      if (!building && quietSince === null) quietSince = Date.now();
      if (building) quietSince = null;
      if (quietSince !== null && Date.now() - quietSince > 500) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.deepEqual([...results.values()], [false, true]);
    assert.equal(getBuildState().building, false);
  });
});
