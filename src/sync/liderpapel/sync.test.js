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

// One feed entry, with only the fields a test cares about overridden.
function entry(sku, overrides = {}) {
  const { features = [], images = [], documents = [], ...row } = overrides;
  return {
    row: {
      sku,
      slug: `${sku}-nombre-original`,
      name: "Nombre original",
      description: "",
      category: "Papelería",
      search_text: "nombre original papeleria",
      price_cents: 1000,
      stock_qty: 5,
      image_url: null,
      gtin: null,
      mpn: null,
      brand: null,
      weight_grams: null,
      dimensions_mm: null,
      feed_active: 1,
      ...row,
    },
    features,
    images,
    documents,
  };
}

const get = (sku) => db.prepare("SELECT * FROM products WHERE sku = ?").get(sku);
const childRows = (table, sku) =>
  db.prepare(`SELECT * FROM ${table} WHERE sku = ? ORDER BY position`).all(sku);

beforeEach(() => {
  db.exec("DELETE FROM products; DELETE FROM product_features; DELETE FROM product_images; DELETE FROM product_documents;");
});

describe("upsertProducts", () => {
  test("keeps the slug fixed when the feed retitles a product", () => {
    upsertProducts([entry("78276")]);
    const before = get("78276").slug;

    // Liderpapel edits INT_VTE, so parse.js derives a different slug.
    upsertProducts([
      entry("78276", { slug: "78276-nombre-nuevo", name: "Nombre nuevo" }),
    ]);

    const after = get("78276");
    assert.equal(after.slug, before, "slug must not follow the feed title");
    assert.equal(after.name, "Nombre nuevo", "name must still track the feed");
  });

  test("stores identifiers and physical facts", () => {
    upsertProducts([
      entry("78276", {
        gtin: "50043859629256",
        mpn: "4691001",
        brand: "Fellowes",
        weight_grams: 21760,
        dimensions_mm: "706x522x368",
      }),
    ]);

    const product = get("78276");
    assert.equal(product.gtin, "50043859629256");
    assert.equal(product.mpn, "4691001");
    assert.equal(product.brand, "Fellowes");
    assert.equal(product.weight_grams, 21760);
    assert.equal(product.dimensions_mm, "706x522x368");
  });

  test("writes child rows with their feed order preserved", () => {
    upsertProducts([
      entry("78276", {
        features: [
          { name: "Marca", value: "Fellowes" },
          { name: "Nivel de seguridad", value: "4" },
        ],
        images: ["https://cdn.test/a.jpg", "https://cdn.test/b.jpg"],
        documents: [{ url: "https://cdn.test/a.pdf", label: "a.pdf" }],
      }),
    ]);

    assert.deepEqual(
      childRows("product_features", "78276").map((r) => [r.name, r.value, r.position]),
      [
        ["Marca", "Fellowes", 0],
        ["Nivel de seguridad", "4", 1],
      ],
    );
    assert.deepEqual(
      childRows("product_images", "78276").map((r) => r.url),
      ["https://cdn.test/a.jpg", "https://cdn.test/b.jpg"],
    );
    assert.equal(childRows("product_documents", "78276").length, 1);
  });

  test("replaces child rows wholesale instead of accumulating them", () => {
    upsertProducts([
      entry("78276", {
        features: [
          { name: "Marca", value: "Fellowes" },
          { name: "Color", value: "Negro" },
        ],
        images: ["https://cdn.test/a.jpg"],
      }),
    ]);

    // Next sync: Liderpapel dropped the Color feature and swapped the image.
    upsertProducts([
      entry("78276", {
        features: [{ name: "Marca", value: "Fellowes" }],
        images: ["https://cdn.test/z.jpg"],
      }),
    ]);

    assert.deepEqual(
      childRows("product_features", "78276").map((r) => r.name),
      ["Marca"],
    );
    assert.deepEqual(
      childRows("product_images", "78276").map((r) => r.url),
      ["https://cdn.test/z.jpg"],
    );
  });

  test("leaves a dropped product's child rows alone, like its row", () => {
    upsertProducts([
      entry("78276", { images: ["https://cdn.test/a.jpg"] }),
      entry("28224", { images: ["https://cdn.test/b.jpg"] }),
    ]);

    // 28224 falls out of the feed entirely.
    upsertProducts([entry("78276", { images: ["https://cdn.test/a.jpg"] })]);

    assert.equal(get("28224").feed_active, 0, "dropped product is deactivated");
    assert.equal(
      childRows("product_images", "28224").length,
      1,
      "its child rows are left in place, not orphaned or deleted",
    );
  });

  test("still never overrides the admin's own active toggle", () => {
    upsertProducts([entry("78276")]);
    db.prepare("UPDATE products SET active = 0 WHERE sku = ?").run("78276");

    upsertProducts([entry("78276", { price_cents: 2000 })]);

    const product = get("78276");
    assert.equal(product.active, 0, "admin toggle survives the sync");
    assert.equal(product.price_cents, 2000, "feed-owned columns still refresh");
  });
});
