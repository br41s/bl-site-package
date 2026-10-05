import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// database.js resolves DB_PATH at import time and refuses to start if it lands
// in a served directory, so point it at a throwaway dir before anything that
// imports it is loaded. A save that moves a price schedules a rebuild, which
// would otherwise build this throwaway database.
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "bl-site-pricing-")), "app.db");
process.env.JWT_SECRET = "test-secret-for-pricing";
process.env.BL_SITE_DISABLE_REBUILD = "1";

const express = (await import("express")).default;
const jwt = (await import("jsonwebtoken")).default;
const db = (await import("../db/database.js")).default;
const { getConfig } = await import("../db/database.js");
const pricingRouter = (await import("./pricing.js")).default;
const { parseMarginPct, marginPricing } = await import("./pricing.js");
const { pvpCents } = await import("../sync/liderpapel/parse.js");

const ADMIN = { Authorization: `Bearer ${jwt.sign({ role: "admin" }, process.env.JWT_SECRET)}` };

let server;
let baseUrl;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/pricing", pricingRouter);
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

function seedProduct(sku, category, cost, priceCents) {
  db.prepare(
    `INSERT INTO products (sku, slug, name, category, cost_ex_vat, price_cents, stock_qty)
     VALUES (?, ?, ?, ?, ?, ?, 5)`,
  ).run(sku, `p-${sku}`, `Producto ${sku}`, category, cost, priceCents);
}

const price = (sku) => db.prepare("SELECT price_cents FROM products WHERE sku = ?").get(sku).price_cents;

function put(body, headers = ADMIN) {
  return fetch(`${baseUrl}/api/pricing/margins`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  db.exec("DELETE FROM products; DELETE FROM category_margins;");
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('liderpapel_margin_pct', '40')").run();
  // 10.00 € cost at 40% + 21% VAT = 16.94 €, the sync's price for it.
  seedProduct("A", "Papelería", 10, 1694);
  seedProduct("B", "Mochilas", 10, 1694);
  // Synced before cost_ex_vat existed: nothing to re-price from.
  seedProduct("OLD", "Papelería", null, 999);
});

describe("pvpCents", () => {
  test("matches the price the sync has always given at 40%", () => {
    // The formula before margins were configurable, verbatim.
    const legacy = (cost) => Math.round(cost * (1 + 40 / 100) * (1 + 0.21) * 100);
    for (const cost of [0, 0.0345, 1, 9.99, 10, 123.456, 1999.9]) {
      assert.equal(pvpCents(cost, 40), legacy(cost));
    }
  });
});

describe("parseMarginPct", () => {
  test("accepts a Spanish decimal comma", () => {
    assert.equal(parseMarginPct("12,5"), 12.5);
  });

  test("allows 0 and up to 200%, rounded to two decimals", () => {
    assert.equal(parseMarginPct(0), 0);
    assert.equal(parseMarginPct("200"), 200);
    assert.equal(parseMarginPct("33.3333"), 33.33);
  });

  test("rejects what is not a margin", () => {
    for (const bad of ["", "abc", -1, "-5", 200.01, "400", null, undefined, NaN, {}, []]) {
      assert.equal(parseMarginPct(bad), null, `accepted ${JSON.stringify(bad)}`);
    }
  });
});

describe("PUT /api/pricing/margins", () => {
  test("requires the panel login", async () => {
    const res = await put({ default_pct: 50 }, {});
    assert.equal(res.status, 401);
  });

  test("a category margin re-prices only that category", async () => {
    const res = await put({ margins: { Papelería: 60 } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.repriced, 1);
    assert.equal(price("A"), pvpCents(10, 60));
    assert.equal(price("B"), 1694);
  });

  test("the general margin re-prices every category without its own", async () => {
    await put({ margins: { Papelería: 60 } });
    await put({ default_pct: 50 });
    assert.equal(price("A"), pvpCents(10, 60));
    assert.equal(price("B"), pvpCents(10, 50));
    assert.equal(getConfig("liderpapel_margin_pct"), "50");
  });

  test("clearing a category margin falls back to the general one", async () => {
    await put({ margins: { Papelería: 60 } });
    await put({ margins: { Papelería: null } });
    assert.equal(price("A"), 1694);
    assert.deepEqual(marginPricing().margins, {});
  });

  test("a product with no stored cost keeps its price, and is reported", async () => {
    const body = await (await put({ default_pct: 50 })).json();
    assert.equal(price("OLD"), 999);
    assert.equal(body.pending, 1);
  });

  test("one bad value rejects the whole request", async () => {
    const res = await put({ default_pct: 50, margins: { Papelería: 60, Mochilas: "abc" } });
    assert.equal(res.status, 400);
    assert.equal(getConfig("liderpapel_margin_pct"), "40");
    assert.deepEqual(marginPricing().margins, {});
    assert.equal(price("A"), 1694);
  });

  test("saving what is already there moves no price", async () => {
    const body = await (await put({ default_pct: 40 })).json();
    assert.equal(body.repriced, 0);
  });
});

describe("GET /api/pricing/margins", () => {
  test("lists categories with their own margin, or null for the general one", async () => {
    await put({ margins: { Papelería: 60, Retirada: 30 } });
    const res = await fetch(`${baseUrl}/api/pricing/margins`, { headers: ADMIN });
    const body = await res.json();
    assert.equal(body.default_pct, 40);
    assert.deepEqual(
      body.categories.map((c) => [c.category, c.total, c.margin_pct]),
      [
        ["Mochilas", 1, null],
        ["Papelería", 2, 60],
        // Has a margin but no products: listed so the admin can clear it.
        ["Retirada", 0, 30],
      ],
    );
  });

  test("a malformed stored value falls back to the default, never NaN", async () => {
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('liderpapel_margin_pct', 'cuarenta')").run();
    db.prepare("INSERT INTO category_margins (category, margin_pct) VALUES ('Mochilas', 'mucho')").run();
    const { defaultPct, marginFor } = marginPricing();
    assert.equal(defaultPct, 40);
    assert.equal(marginFor("Mochilas"), 40);
  });
});
