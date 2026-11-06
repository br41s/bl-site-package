import { test, describe, before, beforeEach, after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Same throwaway-DB setup as b2b.test.js: DB_PATH before database.js loads,
// no real Eleventy build behind config writes.
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "bl-site-reservations-shipping-")), "app.db");
process.env.JWT_SECRET = "test-secret-for-shipping";
process.env.BL_SITE_DISABLE_REBUILD = "1";

const express = (await import("express")).default;
const nodemailer = (await import("nodemailer")).default;
const db = (await import("../db/database.js")).default;
const b2bRouter = (await import("./b2b.js")).default;
const { hashPassword } = await import("./b2b.js");
const reservationsRouter = (await import("./reservations.js")).default;

let server;
let baseUrl;
let sent;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/b2b", b2bRouter);
  app.use("/api/reservations", reservationsRouter);
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  // Captures what src/mail/mailer.js would send, instead of opening SMTP.
  mock.method(nodemailer, "createTransport", () => ({
    sendMail: async (message) => {
      sent.push(message);
    },
  }));
});

after(() => {
  mock.restoreAll();
  server?.close();
});

function setConfig(key, value) {
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(key, value);
}

beforeEach(() => {
  sent = [];
  db.exec(`
    DELETE FROM products; DELETE FROM b2b_accounts; DELETE FROM reservations;
    DELETE FROM reservation_items; DELETE FROM config;
  `);
  db.prepare(
    "INSERT INTO products (sku, slug, name, category, price_cents, stock_qty) VALUES ('A1', 'p-a1', 'Cuaderno', 'Cuadernos', 1210, 5)",
  ).run();
  setConfig("company_name", "Papelería Test");
  setConfig("smtp_host", "smtp.example.com");
  setConfig("smtp_user", "web@example.com");
  setConfig("smtp_pass", "secret");
  setConfig("notify_email", "tienda@example.com");
  setConfig("b2b_enabled", "1");
  setConfig("b2b_default_discount_pct", "0");
});

function reserve(headers = {}, extra = { accept_terms: true }) {
  return fetch(`${baseUrl}/api/reservations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      customer_name: "Ana",
      customer_email: "ana@cliente.es",
      items: [{ sku: "A1", quantity: 2 }],
      ...extra,
    }),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
}


const customerEmail = () => sent.find((m) => m.to === "ana@cliente.es");

describe("shipping zones", () => {
  const ZONES = JSON.stringify([
    { id: "peninsula", label: "Península", price_cents: 700 },
    { id: "portugal", label: "Portugal", price_cents: 1400 },
    { id: "baleares", label: "Baleares", price_cents: 1000 },
  ]);

  test("with no zones configured the checkout is unchanged", async () => {
    const { status, body } = await reserve();
    assert.equal(status, 201);
    assert.equal(body.total_cents, 2420);
    assert.equal(body.shipping_cents, null);
  });

  test("the zone's price is added to the total and to the transfer amount, server-side", async () => {
    setConfig("shipping_zones", ZONES);
    setConfig("bank_iban", "ES4301824731840201605267");
    const { status, body } = await reserve({}, { accept_terms: true, shipping_zone: "portugal" });
    assert.equal(status, 201);
    assert.equal(body.total_cents, 2420 + 1400);
    assert.equal(body.payment.amount_cents, 2420 + 1400);
    const row = db.prepare("SELECT shipping_zone, shipping_cents FROM reservations WHERE id = ?").get(body.id);
    assert.deepEqual({ ...row }, { shipping_zone: "Portugal", shipping_cents: 1400 });
    assert.match(customerEmail().text, /Envío \(Portugal\): 14\.00 €/);
  });

  test("other destinations, a missing zone and an unknown zone are refused", async () => {
    setConfig("shipping_zones", ZONES);
    for (const shipping_zone of ["otros", undefined, "marte"]) {
      const { status } = await reserve({}, { accept_terms: true, shipping_zone });
      assert.equal(status, 400, `zone ${shipping_zone}`);
    }
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM reservations").get().n, 0);
  });

  test("a business account pays the zone net of VAT, with the VAT in vat_cents", async () => {
    setConfig("shipping_zones", ZONES);
    db.prepare(
      "INSERT INTO b2b_accounts (company_name, email, password_hash) VALUES ('ACME S.L.', 'compras@acme.es', ?)",
    ).run(hashPassword("secreto-123"));
    const login = await fetch(`${baseUrl}/api/b2b/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "compras@acme.es", password: "secreto-123" }),
    });
    const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
    const { body } = await reserve({ Cookie: cookie }, { accept_terms: true, shipping_zone: "peninsula" });
    assert.equal(body.shipping_cents, 579); // 700 / 1.21
    assert.equal(body.vat_included, false);
    // items: 2 x 1210 = 2420 gross -> 2000 net; + 579 shipping net
    assert.equal(body.total_cents, 2000 + 579);
    assert.equal(body.vat_cents, Math.round((2000 + 579) * 0.21));
  });
});
