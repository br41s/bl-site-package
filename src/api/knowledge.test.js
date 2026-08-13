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
});
