import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// database.js resolves DB_PATH at import time and refuses to start if it lands
// in a served directory, so point it at a throwaway dir before anything that
// imports it is loaded. Same reasoning for SITE_DIR: the checks below write
// real files to disk and must never touch the actual build output.
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "bl-site-redirects-api-")), "app.db");
process.env.JWT_SECRET = "test-secret-for-redirects";
const SITE_DIR = mkdtempSync(join(tmpdir(), "bl-site-redirects-site-"));
process.env.SITE_DIR = SITE_DIR;

const express = (await import("express")).default;
const jwt = (await import("jsonwebtoken")).default;
const db = (await import("../db/database.js")).default;
const router = (await import("./redirects.js")).default;
const { findLiveRedirect } = await import("./redirects.js");

const TOKEN = jwt.sign({ role: "admin" }, process.env.JWT_SECRET);

let server;
let baseUrl;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/redirects", router);
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

function api(path, options = {}) {
  return fetch(`${baseUrl}/api/redirects${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.auth === false ? {} : { Authorization: `Bearer ${TOKEN}` }),
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
}

// Simulates a built page existing at `urlPath` — either "/foo" (served as
// foo.html by the extensions:["html"] rule) or "/" (index.html).
function pagePath(urlPath) {
  const rel = urlPath === "/" ? "index.html" : `${urlPath.replace(/^\//, "")}.html`;
  return join(SITE_DIR, rel);
}

function writePage(urlPath) {
  const full = pagePath(urlPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, "<html></html>");
}

function removePage(urlPath) {
  unlinkSync(pagePath(urlPath));
}

function seedProduct(sku, overrides = {}) {
  db.prepare(
    `INSERT INTO products (sku, slug, name, description, category, search_text,
       price_cents, stock_qty, gtin, mpn, brand, source_fingerprint, feed_active, active)
     VALUES (@sku, @slug, @name, '', '', '', @price_cents, @stock_qty, @gtin, @mpn, 'Fellowes',
       @source_fingerprint, 1, 1)`,
  ).run({
    sku,
    slug: overrides.slug || `${sku}-producto`,
    name: `Producto ${sku}`,
    price_cents: 10000,
    stock_qty: 5,
    gtin: "50043859629256",
    mpn: "4691001",
    source_fingerprint: "fp",
    ...overrides,
  });
}

beforeEach(() => {
  db.exec("DELETE FROM redirects; DELETE FROM products;");
});

describe("redirects API — access", () => {
  test("refuses unauthenticated reads, writes, publishes and deletes", async () => {
    assert.equal((await api("/", { auth: false })).status, 401);
    assert.equal(
      (await api("/", { method: "POST", body: { old_path: "/a", new_path: "/b" }, auth: false })).status,
      401,
    );
    assert.equal((await api("/1/publish", { method: "POST", auth: false })).status, 401);
    assert.equal((await api("/1", { method: "DELETE", auth: false })).status, 401);
  });
});

describe("redirects API — proposing (server re-checks both ends)", () => {
  test("rejects when old_path still resolves — it isn't dead", async () => {
    writePage("/todavia-viva");
    writePage("/destino");

    const res = await api("/", {
      method: "POST",
      body: { old_path: "/todavia-viva", new_path: "/destino" },
    });

    assert.equal(res.status, 422);
    assert.ok((await res.json()).blockers.some((b) => b.includes("todavía resuelve")));
  });

  test("rejects when new_path does not resolve either", async () => {
    // old_path is genuinely dead (no file written for it); new_path is a typo.
    const res = await api("/", {
      method: "POST",
      body: { old_path: "/muerta", new_path: "/no-existe" },
    });

    assert.equal(res.status, 422);
    assert.ok((await res.json()).blockers.some((b) => b.includes("new_path no resuelve")));
  });

  test("accepts a dead old_path with a live new_path, as pending", async () => {
    writePage("/destino");

    const res = await api("/", { method: "POST", body: { old_path: "/muerta", new_path: "/destino" } });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "pending");
    assert.equal(body.match_tier, "human");
  });

  test("a pending redirect is not served to visitors", async () => {
    writePage("/destino");
    await api("/", { method: "POST", body: { old_path: "/muerta", new_path: "/destino" } });

    assert.equal(findLiveRedirect("/muerta"), undefined);
  });

  test("rejects old_path == new_path", async () => {
    const res = await api("/", { method: "POST", body: { old_path: "/x", new_path: "/x" } });
    assert.equal(res.status, 400);
  });

  test("rejects a new_path that is already the source of another redirect", async () => {
    writePage("/c");
    await api("/", { method: "POST", body: { old_path: "/b", new_path: "/c" } });

    // /b is now a redirect's own old_path (dead, pointing at /c). Using it as
    // someone else's new_path would chain: /a -> /b -> /c.
    const res = await api("/", { method: "POST", body: { old_path: "/a", new_path: "/b" } });
    assert.equal(res.status, 422);
    assert.ok((await res.json()).blockers.some((b) => b.includes("cadena")));
  });
});

describe("redirects API — identifier tiers are re-derived, never trusted", () => {
  test("a gtin claim that matches the target product verifies", async () => {
    seedProduct("100", { slug: "destructora-100" });
    writePage("/productos/destructora-100.html");

    const res = await api("/", {
      method: "POST",
      body: {
        old_path: "/muerta",
        new_path: "/productos/destructora-100.html",
        match_tier: "gtin",
        evidence: { gtin: "50043859629256" },
      },
    });

    assert.equal(res.status, 200);
    assert.equal((await res.json()).match_tier, "gtin");
  });

  test("a gtin claim that does NOT match the target product is rejected", async () => {
    seedProduct("100", { slug: "destructora-100" });

    const res = await api("/", {
      method: "POST",
      body: {
        old_path: "/muerta",
        new_path: "/productos/destructora-100.html",
        match_tier: "gtin",
        evidence: { gtin: "0000000000000" },
      },
    });

    assert.equal(res.status, 422);
    assert.ok((await res.json()).blockers.some((b) => b.includes("gtin")));
  });

  test("an mpn tier claim against a slug with no matching product is rejected", async () => {
    const res = await api("/", {
      method: "POST",
      body: {
        old_path: "/muerta",
        new_path: "/productos/no-existe.html",
        match_tier: "mpn",
        evidence: { mpn: "4691001" },
      },
    });

    assert.equal(res.status, 422);
    assert.ok((await res.json()).blockers.some((b) => b.includes("no se encontró un producto")));
  });

  test("an unrecognized tier falls back to 'human'", async () => {
    seedProduct("100", { slug: "destructora-100" });
    writePage("/productos/destructora-100.html");
    const res = await api("/", {
      method: "POST",
      body: {
        old_path: "/muerta",
        new_path: "/productos/destructora-100.html",
        match_tier: "wat",
      },
    });

    assert.equal(res.status, 200);
    assert.equal((await res.json()).match_tier, "human");
  });
});

describe("redirects API — publishing", () => {
  test("publish flips a pending redirect to live and it is then served", async () => {
    writePage("/destino");
    const created = await (
      await api("/", { method: "POST", body: { old_path: "/muerta", new_path: "/destino" } })
    ).json();

    const res = await api(`/${created.id}/publish`, { method: "POST" });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, "live");

    const live = findLiveRedirect("/muerta");
    assert.equal(live.new_path, "/destino");
  });

  test("refuses to publish if new_path no longer resolves", async () => {
    // The site changed between proposal and publish: destino existed when the
    // redirect was proposed, but has since been removed from the build.
    writePage("/destino-fragil");
    const created = await (
      await api("/", { method: "POST", body: { old_path: "/muerta", new_path: "/destino-fragil" } })
    ).json();
    removePage("/destino-fragil");

    const res = await api(`/${created.id}/publish`, { method: "POST" });
    assert.equal(res.status, 422);
    assert.ok((await res.json()).blockers.some((b) => b.includes("ya no resuelve")));
    assert.equal(findLiveRedirect("/muerta"), undefined);
  });

  test("404s publishing a redirect that doesn't exist", async () => {
    const res = await api("/999999/publish", { method: "POST" });
    assert.equal(res.status, 404);
  });
});

describe("redirects API — listing and deleting", () => {
  test("lists, optionally filtered by status", async () => {
    writePage("/d1");
    writePage("/d2");
    const a = await (
      await api("/", { method: "POST", body: { old_path: "/m1", new_path: "/d1" } })
    ).json();
    await api("/", { method: "POST", body: { old_path: "/m2", new_path: "/d2" } });
    await api(`/${a.id}/publish`, { method: "POST" });

    const all = await (await api("/")).json();
    assert.equal(all.redirects.length, 2);

    const live = await (await api("/?status=live")).json();
    assert.deepEqual(live.redirects.map((r) => r.old_path), ["/m1"]);

    const pending = await (await api("/?status=pending")).json();
    assert.deepEqual(pending.redirects.map((r) => r.old_path), ["/m2"]);
  });

  test("delete removes a redirect and it stops being served", async () => {
    writePage("/destino");
    const created = await (
      await api("/", { method: "POST", body: { old_path: "/muerta", new_path: "/destino" } })
    ).json();
    await api(`/${created.id}/publish`, { method: "POST" });
    assert.ok(findLiveRedirect("/muerta"));

    const res = await api(`/${created.id}`, { method: "DELETE" });
    assert.equal(res.status, 200);
    assert.equal(findLiveRedirect("/muerta"), undefined);
  });

  test("404s deleting a redirect that doesn't exist", async () => {
    const res = await api("/999999", { method: "DELETE" });
    assert.equal(res.status, 404);
  });
});
