import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// database.js resolves DB_PATH at import time and refuses to start if it lands
// in a served directory, so point it at a throwaway dir before anything that
// imports it is loaded.
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "bl-site-sync-")), "app.db");

const db = (await import("../../db/database.js")).default;
const { upsertProducts } = await import("./sync.js");

// One feed row, with only the fields a test cares about overridden.
function row(sku, overrides = {}) {
  return {
    sku,
    slug: `${sku}-nombre-original`,
    name: "Nombre original",
    description: "",
    category: "Papelería",
    search_text: "nombre original papeleria",
    price_cents: 1000,
    stock_qty: 5,
    image_url: null,
    feed_active: 1,
    ...overrides,
  };
}

const get = (sku) => db.prepare("SELECT * FROM products WHERE sku = ?").get(sku);

beforeEach(() => {
  db.exec("DELETE FROM products;");
});

describe("upsertProducts", () => {
  test("keeps the slug fixed when the feed retitles a product", () => {
    upsertProducts([row("78276")]);
    const before = get("78276").slug;

    // Liderpapel edits INT_VTE, so parse.js derives a different slug.
    upsertProducts([row("78276", { slug: "78276-nombre-nuevo", name: "Nombre nuevo" })]);

    const after = get("78276");
    assert.equal(after.slug, before, "slug must not follow the feed title");
    assert.equal(after.name, "Nombre nuevo", "name must still track the feed");
  });

  test("still never overrides the admin's own active toggle", () => {
    upsertProducts([row("78276")]);
    db.prepare("UPDATE products SET active = 0 WHERE sku = ?").run("78276");

    upsertProducts([row("78276", { price_cents: 2000 })]);

    const product = get("78276");
    assert.equal(product.active, 0, "admin toggle survives the sync");
    assert.equal(product.price_cents, 2000, "feed-owned columns still refresh");
  });
});
