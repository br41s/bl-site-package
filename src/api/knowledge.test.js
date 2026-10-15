import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// database.js resolves DB_PATH at import time and refuses to start if it lands
// in a served directory, so point it at a throwaway dir before anything that
// imports it is loaded.
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "bl-site-api-")), "app.db");
process.env.JWT_SECRET = "test-secret-for-knowledge";

const express = (await import("express")).default;
const db = (await import("../db/database.js")).default;
const knowledgeRouter = (await import("./knowledge.js")).default;

let server;
let baseUrl;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/knowledge", knowledgeRouter);
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  db.close();
});

beforeEach(() => {
  db.prepare("DELETE FROM config").run();
  db.prepare("DELETE FROM articles").run();
  db.prepare("DELETE FROM products").run();
  db.prepare("DELETE FROM product_content").run();
});

function call(method, path, { token, body } = {}) {
  return fetch(baseUrl + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("GET /api/knowledge", () => {
  test("returns 404 when KNOWLEDGE_API_TOKEN is not set", async () => {
    // Ensure token is not set in this test
    delete process.env.KNOWLEDGE_API_TOKEN;
    const res = await call("GET", "/api/knowledge", { token: "any-token" });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error, "not_found");
  });

  test("returns 401 when Authorization header is missing", async () => {
    process.env.KNOWLEDGE_API_TOKEN = "test-token-123";
    const res = await call("GET", "/api/knowledge");
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, "unauthorized");
    delete process.env.KNOWLEDGE_API_TOKEN;
  });

  test("returns 401 when Authorization header has no Bearer prefix", async () => {
    process.env.KNOWLEDGE_API_TOKEN = "test-token-123";
    const res = await fetch(baseUrl + "/api/knowledge", {
      headers: {
        Authorization: "test-token-123",
      },
    });
    assert.equal(res.status, 401);
    delete process.env.KNOWLEDGE_API_TOKEN;
  });

  test("returns 401 when token does not match", async () => {
    process.env.KNOWLEDGE_API_TOKEN = "correct-token";
    const res = await call("GET", "/api/knowledge", { token: "wrong-token" });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, "unauthorized");
    delete process.env.KNOWLEDGE_API_TOKEN;
  });

  test("returns 200 with correct token", async () => {
    process.env.KNOWLEDGE_API_TOKEN = "test-token-123";
    const res = await call("GET", "/api/knowledge", { token: "test-token-123" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.generated_at);
    assert.ok(body.business !== undefined);
    assert.ok(body.pages !== undefined);
    assert.ok(Array.isArray(body.articles));
    assert.ok(Array.isArray(body.products));
    assert.ok(Array.isArray(body.operational_facts));
    assert.ok(body.etag);
    delete process.env.KNOWLEDGE_API_TOKEN;
  });

  test("does not leak secrets in response", async () => {
    process.env.KNOWLEDGE_API_TOKEN = "test-token-123";

    // Set some secrets in config
    db.prepare("INSERT INTO config (key, value) VALUES (?, ?)").run(
      "openrouter_api_key",
      "sk-secret-openrouter-key"
    );
    db.prepare("INSERT INTO config (key, value) VALUES (?, ?)").run(
      "smtp_pass",
      "secret-smtp-password"
    );
    db.prepare("INSERT INTO config (key, value) VALUES (?, ?)").run(
      "smtp_user",
      "smtp@example.com"
    );
    db.prepare("INSERT INTO config (key, value) VALUES (?, ?)").run(
      "smtp_host",
      "mail.example.com"
    );

    const res = await call("GET", "/api/knowledge", { token: "test-token-123" });
    const raw = await res.text();

    for (const secret of [
      "sk-secret-openrouter-key",
      "secret-smtp-password",
      "smtp@example.com",
      "mail.example.com",
    ]) {
      assert.ok(!raw.includes(secret), `response leaked secret: ${secret}`);
    }

    delete process.env.KNOWLEDGE_API_TOKEN;
  });

  test("does not include draft articles", async () => {
    process.env.KNOWLEDGE_API_TOKEN = "test-token-123";

    db.prepare(
      "INSERT INTO articles (title, slug, content, status) VALUES (?, ?, ?, ?)"
    ).run("Published Post", "published-post", "Published content", "published");

    db.prepare(
      "INSERT INTO articles (title, slug, content, status) VALUES (?, ?, ?, ?)"
    ).run("Draft Post", "draft-post", "Draft content", "draft");

    const res = await call("GET", "/api/knowledge", { token: "test-token-123" });
    const body = await res.json();

    assert.equal(body.articles.length, 1);
    assert.equal(body.articles[0].title, "Published Post");
    assert.ok(!body.articles[0].body.includes("Draft"));

    delete process.env.KNOWLEDGE_API_TOKEN;
  });

  test("does not include inactive products", async () => {
    process.env.KNOWLEDGE_API_TOKEN = "test-token-123";

    db.prepare(
      "INSERT INTO products (sku, slug, name, active, feed_active) VALUES (?, ?, ?, ?, ?)"
    ).run("SKU1", "product-1", "Active Product", 1, 1);

    db.prepare(
      "INSERT INTO products (sku, slug, name, active, feed_active) VALUES (?, ?, ?, ?, ?)"
    ).run("SKU2", "product-2", "Inactive Product", 0, 1);

    db.prepare(
      "INSERT INTO products (sku, slug, name, active, feed_active) VALUES (?, ?, ?, ?, ?)"
    ).run("SKU3", "product-3", "Not In Feed", 1, 0);

    const res = await call("GET", "/api/knowledge", { token: "test-token-123" });
    const body = await res.json();

    assert.equal(body.products.length, 1);
    assert.equal(body.products[0].name, "Active Product");
    assert.ok(!body.products[0].name.includes("Inactive"));

    delete process.env.KNOWLEDGE_API_TOKEN;
  });

  test("includes business config keys when set", async () => {
    process.env.KNOWLEDGE_API_TOKEN = "test-token-123";

    db.prepare("INSERT INTO config (key, value) VALUES (?, ?)").run(
      "company_name",
      "My Company"
    );
    db.prepare("INSERT INTO config (key, value) VALUES (?, ?)").run(
      "sector",
      "Technology"
    );
    db.prepare("INSERT INTO config (key, value) VALUES (?, ?)").run(
      "biz_phone",
      "+34 912 345 678"
    );

    const res = await call("GET", "/api/knowledge", { token: "test-token-123" });
    const body = await res.json();

    assert.equal(body.business.company_name, "My Company");
    assert.equal(body.business.sector, "Technology");
    assert.equal(body.business.biz_phone, "+34 912 345 678");

    delete process.env.KNOWLEDGE_API_TOKEN;
  });

  test("includes pages when configured", async () => {
    process.env.KNOWLEDGE_API_TOKEN = "test-token-123";

    db.prepare("INSERT INTO config (key, value) VALUES (?, ?)").run(
      "page_index_title",
      "Welcome"
    );
    db.prepare("INSERT INTO config (key, value) VALUES (?, ?)").run(
      "page_index_body",
      "Welcome to our site"
    );
    db.prepare("INSERT INTO config (key, value) VALUES (?, ?)").run(
      "page_quienes_title",
      "About Us"
    );
    db.prepare("INSERT INTO config (key, value) VALUES (?, ?)").run(
      "page_quienes_subtitle",
      "Our story"
    );

    const res = await call("GET", "/api/knowledge", { token: "test-token-123" });
    const body = await res.json();

    assert.ok(body.pages.index);
    assert.equal(body.pages.index.title, "Welcome");
    assert.equal(body.pages.index.body, "Welcome to our site");

    assert.ok(body.pages.quienes);
    assert.equal(body.pages.quienes.title, "About Us");
    assert.equal(body.pages.quienes.description, "Our story");

    delete process.env.KNOWLEDGE_API_TOKEN;
  });

  test("truncates article bodies to 1500 characters", async () => {
    process.env.KNOWLEDGE_API_TOKEN = "test-token-123";

    const longContent = "x".repeat(2000);
    db.prepare(
      "INSERT INTO articles (title, slug, content, status) VALUES (?, ?, ?, ?)"
    ).run("Long Post", "long-post", longContent, "published");

    const res = await call("GET", "/api/knowledge", { token: "test-token-123" });
    const body = await res.json();

    assert.equal(body.articles[0].body.length, 1501); // 1500 + "…"
    assert.ok(body.articles[0].body.endsWith("…"));

    delete process.env.KNOWLEDGE_API_TOKEN;
  });

  test("truncates product descriptions to 500 characters", async () => {
    process.env.KNOWLEDGE_API_TOKEN = "test-token-123";

    const longDesc = "y".repeat(600);
    db.prepare(
      "INSERT INTO products (sku, slug, name, description, active, feed_active) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("SKU1", "product-1", "Product", longDesc, 1, 1);

    const res = await call("GET", "/api/knowledge", { token: "test-token-123" });
    const body = await res.json();

    assert.equal(body.products[0].description.length, 501); // 500 + "…"
    assert.ok(body.products[0].description.endsWith("…"));

    delete process.env.KNOWLEDGE_API_TOKEN;
  });

  test("includes correct operational_facts array", async () => {
    process.env.KNOWLEDGE_API_TOKEN = "test-token-123";

    const res = await call("GET", "/api/knowledge", { token: "test-token-123" });
    const body = await res.json();

    assert.ok(Array.isArray(body.operational_facts));
    assert.ok(body.operational_facts.length > 0);
    for (const fact of body.operational_facts) {
      assert.equal(typeof fact, "string");
    }

    delete process.env.KNOWLEDGE_API_TOKEN;
  });

  test("etag is a stable 16-character hex string", async () => {
    process.env.KNOWLEDGE_API_TOKEN = "test-token-123";

    const res = await call("GET", "/api/knowledge", { token: "test-token-123" });
    const body = await res.json();

    assert.ok(/^[a-f0-9]{16}$/.test(body.etag));

    delete process.env.KNOWLEDGE_API_TOKEN;
  });

  test("product price_eur is price_cents divided by 100", async () => {
    process.env.KNOWLEDGE_API_TOKEN = "test-token-123";

    db.prepare(
      "INSERT INTO products (sku, slug, name, price_cents, active, feed_active) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("SKU1", "product-1", "Product", 2999, 1, 1);

    const res = await call("GET", "/api/knowledge", { token: "test-token-123" });
    const body = await res.json();

    assert.equal(body.products[0].price_eur, 29.99);

    delete process.env.KNOWLEDGE_API_TOKEN;
  });

  test("product in_stock reflects stock_qty > 0", async () => {
    process.env.KNOWLEDGE_API_TOKEN = "test-token-123";

    db.prepare(
      "INSERT INTO products (sku, slug, name, stock_qty, active, feed_active) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("SKU1", "product-1", "In Stock", 10, 1, 1);

    db.prepare(
      "INSERT INTO products (sku, slug, name, stock_qty, active, feed_active) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("SKU2", "product-2", "Out of Stock", 0, 1, 1);

    const res = await call("GET", "/api/knowledge", { token: "test-token-123" });
    const body = await res.json();

    assert.equal(body.products[0].in_stock, true);
    assert.equal(body.products[1].in_stock, false);

    delete process.env.KNOWLEDGE_API_TOKEN;
  });

  // --- the offer: what the bot needs to answer "what do you sell / how" ---

  test("a page's prose in page_*_desc survives a subtitle, as text", async () => {
    process.env.KNOWLEDGE_API_TOKEN = "test-token-123";
    const ins = db.prepare("INSERT INTO config (key, value) VALUES (?, ?)");
    ins.run("page_servicios_title", "Servicios");
    ins.run("page_servicios_subtitle", "Lo que hacemos");
    ins.run("page_servicios_desc", "Reformas **integrales** y baños.");

    const res = await call("GET", "/api/knowledge", { token: "test-token-123" });
    const body = await res.json();

    assert.equal(body.pages.servicios.description, "Lo que hacemos");
    assert.equal(body.pages.servicios.text, "Lo que hacemos Reformas integrales y baños.");
    assert.equal(body.pages.servicios.url, "/servicios");
    delete process.env.KNOWLEDGE_API_TOKEN;
  });

  test("product and post URLs are the clean paths the server actually serves (no trailing slash)", async () => {
    process.env.KNOWLEDGE_API_TOKEN = "test-token-123";
    db.prepare("INSERT INTO products (sku, slug, name, category, price_cents, active, feed_active) VALUES (?, ?, ?, ?, ?, 1, 1)")
      .run("SKU1", "grapadora-x", "Grapadora", "Grapadoras y Grapas", 1299);
    db.prepare("INSERT INTO articles (title, slug, content, status) VALUES (?, ?, ?, 'published')")
      .run("Post", "mi-post", "Texto", );

    const res = await call("GET", "/api/knowledge", { token: "test-token-123" });
    const body = await res.json();

    assert.equal(body.products[0].url, "/productos/grapadora-x");
    assert.equal(body.products[0].category_url, "/productos/categoria/grapadoras-y-grapas/");
    assert.equal(body.products[0].vat_included, true);
    assert.equal(body.articles[0].url, "/blog/mi-post");
    delete process.env.KNOWLEDGE_API_TOKEN;
  });

  test("owned sheets replace the feed's copy and come first; in-stock before out-of-stock", async () => {
    process.env.KNOWLEDGE_API_TOKEN = "test-token-123";
    const ins = db.prepare("INSERT INTO products (sku, slug, name, description, stock_qty, active, feed_active) VALUES (?, ?, ?, ?, ?, 1, 1)");
    ins.run("A", "a", "AAA feed name", "feed text", 0);
    ins.run("B", "b", "BBB", "feed text", 5);
    ins.run("C", "c", "CCC", "feed text", 0);
    db.prepare("INSERT INTO product_content (sku, display_name, description_md, status) VALUES (?, ?, ?, ?)")
      .run("A", "Nuestro nombre", "Nuestra **ficha** propia", "owned");
    db.prepare("INSERT INTO product_content (sku, display_name, description_md, status) VALUES (?, ?, ?, ?)")
      .run("C", "Borrador", "no publicado", "enriched");

    const res = await call("GET", "/api/knowledge", { token: "test-token-123" });
    const body = await res.json();

    assert.deepEqual(body.products.map((p) => p.sku), ["A", "B", "C"]);
    assert.equal(body.products[0].name, "Nuestro nombre");
    assert.equal(body.products[0].description, "Nuestra ficha propia");
    assert.equal(body.products[2].name, "CCC"); // a draft sheet never renders
    delete process.env.KNOWLEDGE_API_TOKEN;
  });

  test("categories list the whole catalogue even though products are a sample", async () => {
    process.env.KNOWLEDGE_API_TOKEN = "test-token-123";
    const ins = db.prepare("INSERT INTO products (sku, slug, name, category, stock_qty, active, feed_active) VALUES (?, ?, ?, ?, ?, 1, 1)");
    for (let i = 0; i < 70; i++) ins.run(`S${i}`, `s${i}`, `P${i}`, i % 2 ? "Papel" : "Bolígrafos", i % 3 ? 1 : 0);
    ins.run("X", "x", "Inactivo", "Papel", 1);
    db.prepare("UPDATE products SET active = 0 WHERE sku = 'X'").run();

    const res = await call("GET", "/api/knowledge", { token: "test-token-123" });
    const body = await res.json();

    assert.equal(body.products.length, 60);
    assert.equal(body.catalogue.product_count, 70);
    assert.equal(body.catalogue.sample_size, 60);
    assert.deepEqual(body.categories.map((c) => c.name).sort(), ["Bolígrafos", "Papel"]);
    const papel = body.categories.find((c) => c.name === "Papel");
    assert.equal(papel.products, 35);
    assert.equal(papel.url, "/productos/categoria/papel/");
    assert.ok(body.operational_facts.some((f) => f.includes("70 productos en 2 categorías")));
    delete process.env.KNOWLEDGE_API_TOKEN;
  });

  test("FAQ pairs are lifted from the posts' FAQ blocks, deduplicated", async () => {
    process.env.KNOWLEDGE_API_TOKEN = "test-token-123";
    const md = "# T\n\n## Preguntas frecuentes\n\n### ¿Hacéis envíos?\n\nSí, a toda España.\n\n### ¿Cuánto tarda?\n\n48 h.\n";
    db.prepare("INSERT INTO articles (title, slug, content, status) VALUES (?, ?, ?, 'published')").run("Uno", "uno", md);
    db.prepare("INSERT INTO articles (title, slug, content, status) VALUES (?, ?, ?, 'published')").run("Dos", "dos", md);

    const res = await call("GET", "/api/knowledge", { token: "test-token-123" });
    const body = await res.json();

    assert.equal(body.faq.es.length, 2);
    assert.deepEqual(body.faq.es[0], { q: "¿Hacéis envíos?", a: "Sí, a toda España.", url: "/blog/dos" });
    delete process.env.KNOWLEDGE_API_TOKEN;
  });

  test("operational facts follow the deployment's config; catalogue facts only with a catalogue", async () => {
    process.env.KNOWLEDGE_API_TOKEN = "test-token-123";
    let res = await call("GET", "/api/knowledge", { token: "test-token-123" });
    let body = await res.json();
    assert.equal(body.faq.es, undefined);
    assert.ok(!body.operational_facts.some((f) => /IVA|transferencia|pedido/.test(f)));
    assert.ok(!body.operational_facts.some((f) => /teléfono de contacto/.test(f)));

    db.prepare("INSERT INTO products (sku, slug, name, active, feed_active) VALUES ('S', 's', 'P', 1, 1)").run();
    db.prepare("INSERT INTO config (key, value) VALUES ('bank_iban', 'ES00 0000 0000 0000 0000 0000')").run();
    db.prepare("INSERT INTO config (key, value) VALUES ('b2b_enabled', '1')").run();
    db.prepare("INSERT INTO config (key, value) VALUES ('biz_hours', 'L-V 9-18')").run();
    res = await call("GET", "/api/knowledge", { token: "test-token-123" });
    body = await res.json();
    assert.ok(body.operational_facts.some((f) => f.startsWith("Horario: L-V 9-18")));
    assert.ok(body.operational_facts.some((f) => f.includes("IVA incluido")));
    assert.ok(body.operational_facts.some((f) => f.includes("transferencia bancaria")));
    assert.ok(body.operational_facts.some((f) => f.includes("/profesionales")));
    assert.ok(body.operational_facts.some((f) => f.includes("el teléfono es opcional")));
    delete process.env.KNOWLEDGE_API_TOKEN;
  });

  test("etag describes the content, not the clock", async () => {
    process.env.KNOWLEDGE_API_TOKEN = "test-token-123";
    const a = await (await call("GET", "/api/knowledge", { token: "test-token-123" })).json();
    await new Promise((r) => setTimeout(r, 5));
    const b = await (await call("GET", "/api/knowledge", { token: "test-token-123" })).json();
    assert.equal(a.etag, b.etag);
    db.prepare("INSERT INTO config (key, value) VALUES ('company_name', 'Otra')").run();
    const c = await (await call("GET", "/api/knowledge", { token: "test-token-123" })).json();
    assert.notEqual(a.etag, c.etag);
    delete process.env.KNOWLEDGE_API_TOKEN;
  });

  // --- per-turn catalogue search for the bot ---

  test("search is gated like the payload and advertised in it", async () => {
    let res = await call("GET", "/api/knowledge/search?q=pluma");
    assert.equal(res.status, 404);
    process.env.KNOWLEDGE_API_TOKEN = "test-token-123";
    res = await call("GET", "/api/knowledge/search?q=pluma");
    assert.equal(res.status, 401);
    const body = await (await call("GET", "/api/knowledge", { token: "test-token-123" })).json();
    assert.equal(body.catalogue.search_path, "/api/knowledge/search");
    delete process.env.KNOWLEDGE_API_TOKEN;
  });

  test("search matches every word first, then any word ranked by hits; our names win; categories too", async () => {
    process.env.KNOWLEDGE_API_TOKEN = "test-token-123";
    const ins = db.prepare("INSERT INTO products (sku, slug, name, description, category, price_cents, stock_qty, search_text, active, feed_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1)");
    ins.run("P1", "pluma-lamy-safari-azul", "Pluma estilográfica Lamy Safari azul", "Plumín acero", "Plumas estilográficas", 2995, 3, "pluma estilografica lamy safari azul plumin acero");
    ins.run("P2", "pluma-parker-jotter", "Pluma Parker Jotter", "Acero inoxidable", "Plumas estilográficas", 2450, 0, "pluma parker jotter acero inoxidable");
    ins.run("P3", "boligrafo-bic-cristal", "Bolígrafo BIC Cristal", "Punta media", "Bolígrafos", 35, 50, "boligrafo bic cristal punta media");
    db.prepare("INSERT INTO product_content (sku, display_name, description_md, status, search_text) VALUES (?, ?, ?, 'owned', ?)")
      .run("P1", "Lamy Safari, pluma estilográfica azul", "Nuestra ficha", "lamy safari pluma estilografica azul nuestra ficha");

    let r = await (await call("GET", "/api/knowledge/search?q=" + encodeURIComponent("pluma lamy"), { token: "test-token-123" })).json();
    assert.deepEqual(r.products.map((p) => p.sku), ["P1"]);
    assert.equal(r.products[0].name, "Lamy Safari, pluma estilográfica azul");
    assert.equal(r.products[0].url, "/productos/pluma-lamy-safari-azul");
    assert.equal(r.products[0].price_eur, 29.95);

    r = await (await call("GET", "/api/knowledge/search?q=" + encodeURIComponent("necesito una pluma de buena calidad"), { token: "test-token-123" })).json();
    assert.deepEqual(r.products.map((p) => p.sku), ["P1", "P2"], "any-word fallback, in stock first");
    assert.deepEqual(r.categories.map((c) => c.name), ["Plumas estilográficas"]);
    assert.equal(r.categories[0].url, "/productos/categoria/plumas-estilograficas/");

    // Sentence words are dropped; a name hit outranks a description mention.
    ins.run("P4", "carton-pluma-blanco", "Cartón pluma blanco 5 mm", "Plancha ligera", "Papelería", 2577, 9, "carton pluma blanco 5 mm plancha ligera");
    ins.run("P5", "estuche-plano", "Estuche plano", "Para una pluma o un bolígrafo de calidad", "Estuches", 466, 9, "estuche plano para una pluma o un boligrafo de calidad");
    r = await (await call("GET", "/api/knowledge/search?q=" + encodeURIComponent("Hola, necesito una pluma de buena calidad, ¿qué tenéis?"), { token: "test-token-123" })).json();
    assert.deepEqual(r.terms, ["pluma"]);
    assert.deepEqual(r.products.map((p) => p.sku).slice(0, 3), ["P1", "P4", "P2"], "name hits first: in stock, then our owned sheet, then the rest; description mention last");
    assert.equal(r.products.at(-1).sku, "P5");
    assert.deepEqual(r.categories.map((c) => c.name), ["Plumas estilográficas"]);

    r = await (await call("GET", "/api/knowledge/search?q=" + encodeURIComponent("grapadora"), { token: "test-token-123" })).json();
    assert.deepEqual(r.products, []);
    assert.deepEqual(r.categories, []);
    delete process.env.KNOWLEDGE_API_TOKEN;
  });
});
