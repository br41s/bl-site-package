import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// database.js resolves DB_PATH at import time and refuses to start if it lands
// in a served directory, so point it at a throwaway dir before anything that
// imports it is loaded.
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "bl-site-products-")), "app.db");
process.env.JWT_SECRET = "test-secret-for-products";

const express = (await import("express")).default;
const db = (await import("../db/database.js")).default;
const router = (await import("./products.js")).default;

let server;
let baseUrl;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/products", router);
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

function seedProduct(sku, overrides = {}) {
  db.prepare(
    `INSERT INTO products (sku, slug, name, description, category, search_text,
       price_cents, stock_qty, feed_active, active)
     VALUES (@sku, @slug, @name, '', '', '', 1000, 5, @feed_active, @active)`,
  ).run({
    sku,
    slug: `${sku}-producto`,
    name: `Producto ${sku}`,
    feed_active: 1,
    active: 1,
    ...overrides,
  });
}

const count = async () =>
  (await (await fetch(`${baseUrl}/api/products/count`)).json()).count;

beforeEach(() => db.exec("DELETE FROM products;"));

describe("GET /api/products/count", () => {
  test("counts what the site is selling", async () => {
    seedProduct("a");
    seedProduct("b");

    assert.equal(await count(), 2);
  });

  test("is zero on an empty catalogue rather than an error", async () => {
    // A blank instance is a normal deployment — the shared staging site is
    // one. It has to answer 0, not 500, or the smoke test cannot tell an
    // empty site apart from a broken one.
    assert.equal(await count(), 0);
  });

  test("ignores products the admin switched off", async () => {
    seedProduct("visible");
    seedProduct("hidden", { active: 0 });

    assert.equal(await count(), 1);
  });

  test("ignores products that dropped out of the feed", async () => {
    seedProduct("current");
    seedProduct("stale", { feed_active: 0 });

    assert.equal(await count(), 1);
  });

  test("is not shadowed by the :sku route", async () => {
    // Express matches in definition order. Declared after /:sku, "count" is
    // read as a SKU and this returns 404 — which the smoke test would report
    // as "no usable count" rather than as a catalogue collapse.
    seedProduct("a");
    const res = await fetch(`${baseUrl}/api/products/count`);

    assert.equal(res.status, 200);
    assert.equal((await res.json()).count, 1);
  });

  test("does not need authentication", async () => {
    // The smoke test runs with no credentials, and every product it counts
    // already has a public page and a sitemap entry.
    seedProduct("a");
    const res = await fetch(`${baseUrl}/api/products/count`);

    assert.equal(res.status, 200);
  });

  test("still resolves a real sku after count is declared", async () => {
    seedProduct("78276");
    const res = await fetch(`${baseUrl}/api/products/78276`);

    assert.equal(res.status, 200);
    assert.equal((await res.json()).sku, "78276");
  });
});
