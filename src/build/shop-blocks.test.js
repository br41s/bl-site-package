// The catalogue front-page blocks, exercised through the Eleventy data file
// that renders them (site/_data/shopBlocks.js).
//
// This test lives in src/ and NOT next to the file it covers, deliberately —
// see the note at the top of src/build/product-content.test.js and the guard in
// src/build/no-tests-in-site.test.js.

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Writing config would otherwise kick off a real Eleventy build per assertion.
process.env.BL_SITE_DISABLE_REBUILD = "1";
// database.js resolves DB_PATH at import time and refuses to start if it lands
// in a served directory, so point it at a throwaway dir before anything that
// imports it is loaded.
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "bl-site-blocks-")), "app.db");

const { default: db, setConfig } = await import("../db/database.js");
const buildBlocks = (await import("../../site/_data/shopBlocks.js")).default;

// The provider returns the blocks in render order; every assertion below is
// about one of them, so look it up by name.
function block(name) {
  const found = buildBlocks().find((b) => b.name === name);
  assert.ok(found, `no block named ${name}`);
  return found;
}

function seedProduct(sku, overrides = {}) {
  db.prepare(
    `INSERT INTO products (sku, slug, name, category, brand, search_text,
       price_cents, stock_qty, image_url, feed_active, active)
     VALUES (@sku, @slug, @name, @category, @brand, '', @price_cents, @stock_qty,
       @image_url, @feed_active, @active)`,
  ).run({
    sku,
    slug: `${sku}-producto`,
    name: `Producto ${sku}`,
    category: "Escritura",
    brand: "BIC",
    price_cents: 120,
    stock_qty: 5,
    image_url: "https://example.test/img.jpg",
    feed_active: 1,
    active: 1,
    ...overrides,
  });
}

function seedOrder(status, items) {
  const { lastInsertRowid } = db
    .prepare(
      "INSERT INTO reservations (customer_name, customer_email, status, total_cents) VALUES ('Ana', 'ana@example.test', ?, 0)",
    )
    .run(status);
  for (const [sku, quantity] of items) {
    db.prepare(
      "INSERT INTO reservation_items (reservation_id, sku, product_name, unit_price_cents, quantity) VALUES (?, ?, ?, 120, ?)",
    ).run(lastInsertRowid, sku, `Producto ${sku}`, quantity);
  }
}

function enable(block, settings = {}) {
  setConfig(`shop_${block}_enabled`, "1");
  for (const [key, value] of Object.entries(settings)) {
    setConfig(`shop_${block}_${key}`, value);
  }
}

beforeEach(() => {
  db.exec("DELETE FROM reservation_items; DELETE FROM reservations; DELETE FROM products;");
  for (const block of ["vendidos", "destacados", "novedades", "categorias", "marcas"]) {
    setConfig(`shop_${block}_enabled`, "0");
    setConfig(`shop_${block}_mode`, "auto");
    setConfig(`shop_${block}_items`, "");
    setConfig(`shop_${block}_limit`, "8");
  }
  setConfig("shop_blocks_order", "");
});

describe("shop blocks — visibility", () => {
  test("a disabled block is never populated, however much catalogue there is", () => {
    seedProduct("A1");
    assert.equal(block("destacados").enabled, false);
    assert.deepEqual(block("destacados").items, []);
  });

  test("an enabled block with nothing to show stays empty, so the page can hide it", () => {
    enable("vendidos");
    seedProduct("A1");
    // Products exist, but nobody has bought anything.
    assert.equal(block("vendidos").enabled, true);
    assert.deepEqual(block("vendidos").items, []);
  });

  test("limit is clamped to the block maximum however config was written", () => {
    enable("destacados", { limit: "999" });
    for (let i = 0; i < 30; i += 1) seedProduct(`A${i}`);
    assert.equal(block("destacados").items.length, 24);
  });
});

describe("shop blocks — best sellers", () => {
  beforeEach(() => {
    seedProduct("SOLD");
    seedProduct("CART");
    seedProduct("VOID");
  });

  test("unconfirmed carts do not count", () => {
    // POST /api/reservations is public and anonymous: if pending carts counted,
    // anyone could push a product onto the front page by filling one.
    enable("vendidos");
    seedOrder("pending", [["CART", 50]]);
    seedOrder("cancelled", [["VOID", 50]]);
    seedOrder("confirmed", [["SOLD", 1]]);

    const items = block("vendidos").items;
    assert.deepEqual(
      items.map((p) => p.sku),
      ["SOLD"],
    );
  });

  test("a best seller that ran out of stock steps aside", () => {
    // The card would render with a disabled "Añadir" button, which is a worse
    // front page than a shorter row. It comes back when the stock does.
    enable("vendidos");
    db.prepare("UPDATE products SET stock_qty = 0 WHERE sku = 'SOLD'").run();
    seedOrder("confirmed", [["SOLD", 3]]);

    assert.deepEqual(block("vendidos").items, []);
  });

  test("ranked by how many orders included it, not by raw units", () => {
    // One office buying 500 pens is that office's habit, not a best-seller.
    enable("vendidos");
    seedOrder("confirmed", [["CART", 500]]);
    seedOrder("confirmed", [["SOLD", 1]]);
    seedOrder("completed", [["SOLD", 1]]);

    assert.deepEqual(
      block("vendidos").items.map((p) => p.sku),
      ["SOLD", "CART"],
    );
  });
});

describe("shop blocks — automatic picks", () => {
  test("featured skips products with no stock or no photo", () => {
    enable("destacados");
    seedProduct("GOOD");
    seedProduct("NOSTOCK", { stock_qty: 0 });
    seedProduct("NOPHOTO", { image_url: "" });

    assert.deepEqual(
      block("destacados").items.map((p) => p.sku),
      ["GOOD"],
    );
  });

  test("featured puts the sheets we wrote ourselves first", () => {
    enable("destacados");
    seedProduct("FEED");
    seedProduct("OURS");
    db.prepare(
      "INSERT INTO product_content (sku, display_name, description_md, status) VALUES ('OURS', 'Nuestro título', 'Texto.', 'owned')",
    ).run();

    assert.deepEqual(
      block("destacados").items.map((p) => p.sku),
      ["OURS", "FEED"],
    );
  });

  test("inactive products are invisible to every block", () => {
    enable("destacados");
    enable("novedades");
    seedProduct("HIDDEN", { active: 0 });
    seedProduct("GONE", { feed_active: 0 });

    assert.deepEqual(block("destacados").items, []);
    assert.deepEqual(block("novedades").items, []);
  });
});

describe("shop blocks — manual picks", () => {
  test("pinned products render in the order they were pinned", () => {
    enable("destacados", { mode: "manual", items: "B2\nA1" });
    seedProduct("A1");
    seedProduct("B2");

    assert.deepEqual(
      block("destacados").items.map((p) => p.sku),
      ["B2", "A1"],
    );
  });

  test("a pinned product that left the catalogue drops out instead of 404ing", () => {
    enable("destacados", { mode: "manual", items: "A1\nGHOST\nB2" });
    seedProduct("A1");
    seedProduct("B2");

    assert.deepEqual(
      block("destacados").items.map((p) => p.sku),
      ["A1", "B2"],
    );
  });

  test("our own title wins, so the block agrees with the panel's star list", () => {
    enable("destacados", { mode: "manual", items: "A1" });
    seedProduct("A1", { name: "Bolig. bic crist. azul 1.0" });
    db.prepare(
      "INSERT INTO product_content (sku, display_name, description_md, status) VALUES ('A1', 'Bolígrafo BIC Cristal azul', 'Texto.', 'owned')",
    ).run();

    assert.equal(block("destacados").items[0].name, "Bolígrafo BIC Cristal azul");
  });
});

describe("shop blocks — categories and brands", () => {
  beforeEach(() => {
    seedProduct("A1", { category: "Escritura", brand: "BIC" });
    seedProduct("A2", { category: "Escritura", brand: "BIC" });
    seedProduct("B1", { category: "Papelería", brand: "Oxford" });
  });

  test("automatic mode ranks by product count and links to real pages", () => {
    enable("categorias");
    const items = block("categorias").items;
    assert.deepEqual(
      items.map((c) => [c.label, c.total]),
      [
        ["Escritura", 2],
        ["Papelería", 1],
      ],
    );
    assert.equal(items[0].url, "/productos/categoria/escritura/");
    assert.equal(items[0].image_url, "https://example.test/img.jpg");
  });

  test("brands get their own pages", () => {
    enable("marcas");
    assert.equal(block("marcas").items[0].url, "/productos/marca/bic/");
  });

  test("manual mode honours the chosen order and ignores unknown slugs", () => {
    enable("categorias", { mode: "manual", items: "papeleria\ninventada\nescritura" });
    assert.deepEqual(
      block("categorias").items.map((c) => c.slug),
      ["papeleria", "escritura"],
    );
  });
});

describe("shop blocks — config wiring", () => {
  test("every block key is exposed to the build", async () => {
    // PUBLIC_CONFIG_KEYS is hand-written and is what site/_data/site.js and
    // GET /api/site/config read. A key missing from it is saved by the panel and
    // then silently ignored by the build — the failure mode is a setting that
    // appears to work and does nothing. (The write allowlist in src/api/site.js
    // cannot drift the same way: it spreads SHOP_BLOCK_KEYS directly.)
    const { PUBLIC_CONFIG_KEYS } = await import("../db/database.js");
    const { SHOP_BLOCK_KEYS } = await import("../content/shop-blocks.js");
    const missing = SHOP_BLOCK_KEYS.filter((k) => !PUBLIC_CONFIG_KEYS.includes(k));
    assert.deepEqual(missing, []);
  });
});

describe("shop blocks — order", () => {
  const names = () => buildBlocks().map((b) => b.name);

  test("with nothing saved, the registry order is used", () => {
    assert.deepEqual(names(), ["vendidos", "destacados", "novedades", "categorias", "marcas"]);
  });

  test("the saved order wins", () => {
    setConfig("shop_blocks_order", "categorias\nnovedades\nvendidos\nmarcas\ndestacados");
    assert.deepEqual(names(), ["categorias", "novedades", "vendidos", "marcas", "destacados"]);
  });

  test("a block the saved order predates still renders, after the ones it names", () => {
    // The failure this guards against: shipping a sixth block and having it be
    // invisible on every instance whose order was saved when there were five.
    setConfig("shop_blocks_order", "marcas\ncategorias");
    assert.deepEqual(names(), ["marcas", "categorias", "vendidos", "destacados", "novedades"]);
  });

  test("unknown and duplicated names are ignored, not rendered twice", () => {
    setConfig("shop_blocks_order", "novedades\nun-bloque-que-ya-no-existe\nnovedades");
    assert.deepEqual(names(), ["novedades", "vendidos", "destacados", "categorias", "marcas"]);
  });
});
