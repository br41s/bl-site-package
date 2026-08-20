// Ownership precedence for product copy, exercised through the Eleventy data
// file that renders it (site/_data/products.js).
//
// This test lives in src/ and NOT next to the file it covers, deliberately.
// eleventy.config.mjs sets dir.data = "_data", so Eleventy imports every .js
// under site/_data/ as a data provider — and node:test executes a suite on
// import. A test file in that directory therefore runs its own beforeEach
// against the live database on every single build. That mistake emptied a
// 14,487-product catalogue during development. See the guard in
// src/build/no-tests-in-site.test.js.

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// database.js resolves DB_PATH at import time and refuses to start if it lands
// in a served directory, so point it at a throwaway dir before anything that
// imports it is loaded.
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "bl-site-content-")), "app.db");

const db = (await import("../db/database.js")).default;
const products = (await import("../../site/_data/products.js")).default;

const SKU = "78276";
const FEED_FINGERPRINT = "aaaabbbbccccdddd0000111122223333";

function seedProduct(overrides = {}) {
  db.prepare(
    `INSERT INTO products (sku, slug, name, description, category, search_text,
       price_cents, stock_qty, image_url, source_fingerprint, feed_active, active)
     VALUES (@sku, @slug, @name, @description, @category, '', @price_cents, @stock_qty,
       NULL, @source_fingerprint, 1, 1)`,
  ).run({
    sku: SKU,
    slug: `${SKU}-nombre-del-feed`,
    name: "Destructora de documentos fellowes 99ci capacidad de corte 18 hojas",
    description: "Descripción del feed.",
    category: "Destructoras",
    price_cents: 70931,
    stock_qty: 2,
    source_fingerprint: FEED_FINGERPRINT,
    ...overrides,
  });
}

function seedContent(overrides = {}) {
  db.prepare(
    `INSERT INTO product_content (sku, display_name, description_md, status, source_fingerprint)
     VALUES (@sku, @display_name, @description_md, @status, @source_fingerprint)`,
  ).run({
    sku: SKU,
    display_name: "Destructora Fellowes 99Ci — corte en tiras, nivel P-4",
    description_md: "Nuestra **propia** descripción.",
    status: "owned",
    source_fingerprint: FEED_FINGERPRINT,
    ...overrides,
  });
}

const only = () => products()[0];

beforeEach(() => {
  db.exec("DELETE FROM products; DELETE FROM product_content;");
});

describe("product copy ownership", () => {
  test("renders the feed's copy when we own nothing", () => {
    seedProduct();

    const p = only();
    assert.equal(p.owned, false);
    assert.match(p.name, /^Destructora de documentos fellowes/);
    assert.match(p.descriptionHtml, /Descripción del feed/);
  });

  test("our title and body win once the sheet is owned", () => {
    seedProduct();
    seedContent();

    const p = only();
    assert.equal(p.owned, true);
    assert.equal(p.name, "Destructora Fellowes 99Ci — corte en tiras, nivel P-4");
    assert.match(p.descriptionHtml, /Nuestra <strong>propia<\/strong> descripción/);
    assert.doesNotMatch(p.descriptionHtml, /Descripción del feed/);
  });

  test("a draft never reaches a visitor", () => {
    // Anything short of 'owned' is work in progress. The agent writes long
    // before a sheet is finished, and a half-written page must not be served.
    seedProduct();
    seedContent({ status: "enriched" });

    const p = only();
    assert.equal(p.owned, false);
    assert.match(p.name, /^Destructora de documentos fellowes/);
    assert.match(p.descriptionHtml, /Descripción del feed/);
  });

  test("ownership is per field: a title without a body keeps the feed's body", () => {
    seedProduct();
    seedContent({ description_md: null });

    const p = only();
    assert.equal(p.name, "Destructora Fellowes 99Ci — corte en tiras, nivel P-4");
    assert.match(p.descriptionHtml, /Descripción del feed/);
  });

  test("owning the title never moves the URL", () => {
    seedProduct();
    seedContent();

    // The slug is pinned at first publication. Retitling — by us or by
    // Liderpapel — must not orphan an indexed URL.
    assert.equal(only().slug, `${SKU}-nombre-del-feed`);
  });

  test("the feed's own title stays available underneath ours", () => {
    seedProduct();
    seedContent();

    assert.match(only().feedName, /^Destructora de documentos fellowes/);
  });

  test("the JSON-LD describes our copy, not the feed's", () => {
    seedProduct();
    seedContent();

    const ld = only().jsonLd;
    assert.equal(ld.name, "Destructora Fellowes 99Ci — corte en tiras, nivel P-4");
    assert.match(ld.description, /Nuestra propia descripción/);
  });
});

describe("source drift under an owned sheet", () => {
  test("is quiet while the facts underneath are unchanged", () => {
    seedProduct();
    seedContent();

    assert.equal(only().sourceDrifted, false);
  });

  test("is raised when Liderpapel changes the facts we wrote from", () => {
    seedProduct({ source_fingerprint: "99998888777766665555444433332222" });
    seedContent({ source_fingerprint: FEED_FINGERPRINT });

    assert.equal(only().sourceDrifted, true);
  });

  test("keeps serving our copy while drifted, rather than reverting", () => {
    // Drift is a signal for review, not an automatic rollback: the feed's copy
    // is what we replaced for being worse, so silently restoring it would be a
    // downgrade nobody asked for.
    seedProduct({ source_fingerprint: "99998888777766665555444433332222" });
    seedContent({ source_fingerprint: FEED_FINGERPRINT });

    const p = only();
    assert.equal(p.name, "Destructora Fellowes 99Ci — corte en tiras, nivel P-4");
    assert.match(p.descriptionHtml, /Nuestra <strong>propia<\/strong> descripción/);
  });

  test("cannot be raised on a product we do not own", () => {
    seedProduct({ source_fingerprint: "99998888777766665555444433332222" });

    assert.equal(only().sourceDrifted, false);
  });
});
