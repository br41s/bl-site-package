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
const { normalizeForSearch } = await import("../utils/text.js");

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
  const name = overrides.name || `Producto ${sku}`;
  if (overrides.search_text === undefined) overrides.search_text = normalizeForSearch(name);
  db.prepare(
    `INSERT INTO products (sku, slug, name, description, category, search_text,
       price_cents, stock_qty, feed_active, active)
     VALUES (@sku, @slug, @name, '', '', @search_text, 1000, 5, @feed_active, @active)`,
  ).run({
    sku,
    slug: `${sku}-producto`,
    name: `Producto ${sku}`,
    feed_active: 1,
    active: 1,
    search_text: null,
    ...overrides,
  });
}

const count = async () =>
  (await (await fetch(`${baseUrl}/api/products/count`)).json()).count;

beforeEach(() => db.exec("DELETE FROM products; DELETE FROM product_content;"));

describe("GET /api/products — finding a rewritten sheet", () => {
  // Reported from the storefront: the agent renames a product, the page and
  // the panel both show the new title, and searching for that title returns
  // nothing. The one name a visitor can see was the one name they could not
  // search for.
  function own(sku, display_name) {
    db.prepare(
      `INSERT INTO product_content (sku, display_name, status, search_text)
       VALUES (?, ?, 'owned', ?)`,
    ).run(sku, display_name, normalizeForSearch(display_name));
  }

  const search = async (q) =>
    (await (await fetch(`${baseUrl}/api/products?q=${encodeURIComponent(q)}`)).json()).products;

  test("finds a product by the title we gave it", async () => {
    seedProduct("154520", { name: "Impresora de tarjeta badgy 200 incluye cinta" });
    own("154520", "Impresora de tarjetas Badgy200 con cinta y software");

    const hits = await search("Badgy200");
    assert.deepEqual(hits.map((h) => h.sku), ["154520"]);
  });

  test("still finds it by the distributor's wording", async () => {
    // Existing links, old habits and the client's own memory all use it.
    seedProduct("154520", { name: "Impresora de tarjeta badgy 200 incluye cinta" });
    own("154520", "Impresora de tarjetas Badgy200 con cinta y software");

    assert.equal((await search("tarjeta badgy 200")).length, 1);
  });

  test("returns our title, so a result card matches the page it links to", async () => {
    seedProduct("154520", { name: "Impresora de tarjeta badgy 200 incluye cinta" });
    own("154520", "Impresora de tarjetas Badgy200 con cinta y software");

    const [hit] = await search("Badgy200");
    assert.equal(hit.name, "Impresora de tarjetas Badgy200 con cinta y software");
    assert.equal(hit.feed_name, "Impresora de tarjeta badgy 200 incluye cinta");
  });

  test("a draft title is not searchable, since it is not shown", async () => {
    seedProduct("100", { name: "Producto del feed" });
    db.prepare(
      `INSERT INTO product_content (sku, display_name, status, search_text)
       VALUES ('100', 'Título en borrador', 'enriched', 'titulo en borrador')`,
    ).run();

    assert.equal((await search("borrador")).length, 0);
    assert.equal((await search("Producto del feed")).length, 1);
  });

  test("finds a product by its manufacturer reference", async () => {
    // True for the 14,187 products carrying one, rewritten or not — this is
    // what someone replacing a part types.
    seedProduct("21539", {
      name: "Ink-jet hp quietjet",
      search_text: normalizeForSearch("Ink-jet hp quietjet 51604A 0088698004388"),
    });

    assert.equal((await search("51604A")).length, 1);
    assert.equal((await search("0088698004388")).length, 1);
  });

  test("an unsearched listing still works and still prefers our title", async () => {
    seedProduct("a", { name: "Feed A" });
    own("a", "Nuestro título A");
    seedProduct("b", { name: "Feed B" });

    const all = (await (await fetch(`${baseUrl}/api/products`)).json()).products;
    const byName = Object.fromEntries(all.map((p) => [p.sku, p.name]));
    assert.equal(byName.a, "Nuestro título A");
    assert.equal(byName.b, "Feed B");
  });
});

describe("GET /api/products — every word, any order", () => {
  // The search used to LIKE the whole query as one substring, so it only
  // worked if you typed the distributor's exact wording in its exact order.
  // Nobody types a warehouse label from memory.
  const search = async (q) =>
    (await (await fetch(`${baseUrl}/api/products?q=${encodeURIComponent(q)}`)).json()).products;

  function seedRexel() {
    seedProduct("163199", {
      name: "Destructora de documentos rexel momentum x420 particulas",
    });
  }

  test("finds words that are not next to each other", async () => {
    seedRexel();
    assert.equal((await search("Destructora Rexel")).length, 1);
  });

  test("does not care about word order", async () => {
    seedProduct("1", { name: "Boligrafo bic cristal azul" });

    assert.equal((await search("boligrafo bic")).length, 1);
    assert.equal((await search("bic boligrafo")).length, 1);
  });

  test("still requires every word to appear", async () => {
    // Loosening order must not turn the search into an OR, or a two-word
    // query would return everything matching either word.
    seedRexel();
    seedProduct("other", { name: "Boligrafo bic cristal" });

    assert.equal((await search("rexel boligrafo")).length, 0);
  });

  test("a word can come from our title and another from the feed's", async () => {
    seedProduct("163199", { name: "Destructora de documentos rexel momentum x420" });
    db.prepare(
      `INSERT INTO product_content (sku, display_name, status, search_text)
       VALUES ('163199', 'Destructora Rexel Momentum X420 de partículas P-4 — 2104578EU', 'owned',
               'destructora rexel momentum x420 de particulas p-4 2104578eu')`,
    ).run();

    // "documentos" only exists in the feed's wording, "P-4" only in ours.
    assert.equal((await search("documentos p-4")).length, 1);
  });

  test("ignores extra whitespace", async () => {
    seedRexel();
    assert.equal((await search("  Destructora   Rexel  ")).length, 1);
  });

  test("an empty or whitespace-only query lists everything", async () => {
    seedRexel();
    seedProduct("other", { name: "Boligrafo bic" });

    assert.equal((await search("   ")).length, 2);
  });

  test("bounds how many words it will match on", async () => {
    // A pasted paragraph should not become a 200-clause query.
    seedRexel();
    const many = Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ");
    const res = await fetch(`${baseUrl}/api/products?q=${encodeURIComponent(many)}`);
    assert.equal(res.status, 200);
  });
});

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
