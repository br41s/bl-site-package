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
const { parseAdjustPct, adjustPricing } = await import("./pricing.js");
const { pvpCents, retailPriceCents } = await import("../sync/liderpapel/parse.js");

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

function seedProduct(sku, category, { cost = null, pvo = null, vat = 0.21, priceCents }) {
  db.prepare(
    `INSERT INTO products (sku, slug, name, category, cost_ex_vat, pvo_ex_vat, vat_rate, price_cents, stock_qty)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 5)`,
  ).run(sku, `p-${sku}`, `Producto ${sku}`, category, cost, pvo, vat, priceCents);
}

const price = (sku) => db.prepare("SELECT price_cents FROM products WHERE sku = ?").get(sku).price_cents;

function put(body, headers = ADMIN) {
  return fetch(`${baseUrl}/api/pricing/adjustments`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  db.exec("DELETE FROM products; DELETE FROM category_price_adjust;");
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('liderpapel_pvo_adjust_pct', '0')").run();
  // 10.00 € PVO at 0 % + 21 % VAT = 12.10 €, the sync's price for it.
  seedProduct("A", "Papelería", { cost: 5.5, pvo: 10, priceCents: 1210 });
  seedProduct("B", "Mochilas", { cost: 5.5, pvo: 10, priceCents: 1210 });
  // A book: no PVO in the feed, 4 % VAT. Priced from cost at the fallback margin.
  seedProduct("LIBRO", "Papelería", { cost: 10, vat: 0.04, priceCents: 1456 });
  // Synced before the columns existed: nothing to re-price from.
  seedProduct("OLD", "Papelería", { priceCents: 999 });
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

describe("retailPriceCents", () => {
  test("the PVO with the adjustment, at the product's VAT", () => {
    assert.equal(retailPriceCents({ pvo_ex_vat: 10, cost_ex_vat: 5.5, vat_rate: 0.21 }, 0), 1210);
    assert.equal(retailPriceCents({ pvo_ex_vat: 10, cost_ex_vat: 5.5, vat_rate: 0.21 }, -5), 1150);
    assert.equal(retailPriceCents({ pvo_ex_vat: 10, cost_ex_vat: 5.5, vat_rate: 0.04 }, 10), 1144);
  });

  test("without a PVO, the cost at the 40% fallback margin — the adjustment does not apply", () => {
    assert.equal(retailPriceCents({ pvo_ex_vat: null, cost_ex_vat: 10, vat_rate: 0.04 }, -50), 1456);
  });

  test("null when there is nothing to price from", () => {
    assert.equal(retailPriceCents({ pvo_ex_vat: null, cost_ex_vat: null, vat_rate: 0.21 }, 0), null);
    assert.equal(retailPriceCents({ pvo_ex_vat: 0, cost_ex_vat: 0, vat_rate: 0.21 }, 0), null);
  });

  test("a missing VAT rate means the default, never NaN", () => {
    assert.equal(retailPriceCents({ pvo_ex_vat: 10, cost_ex_vat: null, vat_rate: null }, 0), 1210);
  });
});

describe("parseAdjustPct", () => {
  test("accepts a Spanish decimal comma, and a minus", () => {
    assert.equal(parseAdjustPct("12,5"), 12.5);
    assert.equal(parseAdjustPct("-7,5"), -7.5);
  });

  test("allows -50 to 100%, rounded to two decimals", () => {
    assert.equal(parseAdjustPct(0), 0);
    assert.equal(parseAdjustPct("-50"), -50);
    assert.equal(parseAdjustPct("100"), 100);
    assert.equal(parseAdjustPct("33.3333"), 33.33);
  });

  test("rejects what is not an adjustment", () => {
    for (const bad of ["", "abc", -50.01, "-100", 100.01, "200", null, undefined, NaN, {}, []]) {
      assert.equal(parseAdjustPct(bad), null, `accepted ${JSON.stringify(bad)}`);
    }
  });
});

describe("PUT /api/pricing/adjustments", () => {
  test("requires the panel login", async () => {
    const res = await put({ default_pct: 5 }, {});
    assert.equal(res.status, 401);
  });

  test("a category adjustment re-prices only that category", async () => {
    const res = await put({ adjustments: { Papelería: -5 } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.repriced, 1);
    assert.equal(price("A"), 1150);
    assert.equal(price("B"), 1210);
    // No PVO: untouched by the adjustment, still cost-based.
    assert.equal(price("LIBRO"), 1456);
  });

  test("the general adjustment re-prices every category without its own", async () => {
    await put({ adjustments: { Papelería: -5 } });
    await put({ default_pct: 10 });
    assert.equal(price("A"), 1150);
    assert.equal(price("B"), 1331);
    assert.equal(getConfig("liderpapel_pvo_adjust_pct"), "10");
  });

  test("clearing a category adjustment falls back to the general one", async () => {
    await put({ adjustments: { Papelería: -5 } });
    await put({ adjustments: { Papelería: null } });
    assert.equal(price("A"), 1210);
    assert.deepEqual(adjustPricing().adjustments, {});
  });

  test("a product with neither PVO nor cost keeps its price, and is reported", async () => {
    const body = await (await put({ default_pct: 10 })).json();
    assert.equal(price("OLD"), 999);
    assert.equal(body.pending, 1);
  });

  test("one bad value rejects the whole request", async () => {
    const res = await put({ default_pct: 10, adjustments: { Papelería: -5, Mochilas: "abc" } });
    assert.equal(res.status, 400);
    assert.equal(getConfig("liderpapel_pvo_adjust_pct"), "0");
    assert.deepEqual(adjustPricing().adjustments, {});
    assert.equal(price("A"), 1210);
  });

  test("saving what is already there moves no price", async () => {
    const body = await (await put({ default_pct: 0 })).json();
    assert.equal(body.repriced, 0);
  });

  test("the old cost margin is never read: 40 in liderpapel_margin_pct does not price anything", async () => {
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('liderpapel_margin_pct', '40')").run();
    db.prepare("INSERT INTO category_margins (category, margin_pct) VALUES ('Papelería', 60)").run();
    const body = await (await put({ default_pct: 0 })).json();
    assert.equal(body.repriced, 0);
    assert.equal(adjustPricing().defaultPct, 0);
  });
});

describe("GET /api/pricing/adjustments", () => {
  test("lists categories with their own adjustment, or null for the general one", async () => {
    await put({ adjustments: { Papelería: -5, Retirada: 3 } });
    const res = await fetch(`${baseUrl}/api/pricing/adjustments`, { headers: ADMIN });
    const body = await res.json();
    assert.equal(body.default_pct, 0);
    assert.deepEqual(
      body.categories.map((c) => [c.category, c.total, c.adjust_pct]),
      [
        ["Mochilas", 1, null],
        ["Papelería", 3, -5],
        // Has an adjustment but no products: listed so the admin can clear it.
        ["Retirada", 0, 3],
      ],
    );
  });

  test("a malformed stored value falls back to the default, never NaN", async () => {
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('liderpapel_pvo_adjust_pct', 'cinco')").run();
    db.prepare("INSERT INTO category_price_adjust (category, adjust_pct) VALUES ('Mochilas', 'mucho')").run();
    const { defaultPct, adjustFor } = adjustPricing();
    assert.equal(defaultPct, 0);
    assert.equal(adjustFor("Mochilas"), 0);
  });
});
