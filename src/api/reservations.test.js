import { test, describe, before, beforeEach, after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Same throwaway-DB setup as b2b.test.js: DB_PATH before database.js loads,
// no real Eleventy build behind config writes.
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "bl-site-reservations-")), "app.db");
process.env.JWT_SECRET = "test-secret-for-reservations";
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

function reserve(headers = {}) {
  return fetch(`${baseUrl}/api/reservations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      customer_name: "Ana",
      customer_email: "ana@cliente.es",
      items: [{ sku: "A1", quantity: 2 }],
    }),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
}

const customerEmail = () => sent.find((m) => m.to === "ana@cliente.es");
const ownerEmail = () => sent.find((m) => m.to === "tienda@example.com");

describe("payment instructions", () => {
  test("a retail reservation gets the bank details, its total and its number as reference", async () => {
    setConfig("bank_holder", "Papelería Test S.L.");
    setConfig("bank_iban", "ES4301824731840201605267");
    setConfig("bank_bic", "bbvaesmmxxx");
    const { status, body } = await reserve();
    assert.equal(status, 201);
    assert.deepEqual(body.payment, {
      method: "transfer",
      holder: "Papelería Test S.L.",
      iban: "ES43 0182 4731 8402 0160 5267",
      bic: "BBVAESMMXXX",
      reference: `Reserva ${body.id}`,
      amount_cents: 2420,
    });

    const mail = customerEmail();
    assert.ok(mail, "the customer gets a confirmation");
    assert.match(mail.subject, new RegExp(`nº ${body.id}`));
    assert.match(mail.text, /ES43 0182 4731 8402 0160 5267/);
    assert.match(mail.text, /24\.20 €/);
    assert.match(mail.text, new RegExp(`Concepto: Reserva ${body.id}`));
    assert.match(ownerEmail().text, /Pago: por transferencia/);
    const row = db.prepare("SELECT status FROM reservations WHERE id = ?").get(body.id);
    assert.equal(row.status, "awaiting_payment");
  });

  test("only a transfer reservation starts as awaiting payment, and the panel can confirm it", async () => {
    const plain = await reserve();
    assert.equal(db.prepare("SELECT status FROM reservations WHERE id = ?").get(plain.body.id).status, "pending");

    setConfig("bank_iban", "ES4301824731840201605267");
    const { body } = await reserve();
    const jwt = (await import("jsonwebtoken")).default;
    const res = await fetch(`${baseUrl}/api/reservations/${body.id}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt.sign({ role: "admin" }, process.env.JWT_SECRET)}`,
      },
      body: JSON.stringify({ status: "confirmed" }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, "confirmed");
  });

  test("a business account never sees the IBAN and is told it pays as usual", async () => {
    setConfig("bank_iban", "ES4301824731840201605267");
    db.prepare(
      "INSERT INTO b2b_accounts (company_name, email, password_hash) VALUES ('ACME S.L.', 'compras@acme.es', ?)",
    ).run(hashPassword("secreto-123"));
    const login = await fetch(`${baseUrl}/api/b2b/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "compras@acme.es", password: "secreto-123" }),
    });
    const cookie = (login.headers.get("set-cookie") || "").split(";")[0];

    const { body } = await reserve({ Cookie: cookie });
    assert.equal(body.b2b, true);
    assert.deepEqual(body.payment, { method: "usual" });
    assert.doesNotMatch(customerEmail().text, /IBAN|ES43/);
    assert.match(customerEmail().text, /forma de pago habitual/);
    assert.equal(db.prepare("SELECT status FROM reservations WHERE id = ?").get(body.id).status, "pending");
  });

  test("with no IBAN set, nothing changes but the customer still gets a confirmation", async () => {
    const { body } = await reserve();
    assert.equal(body.payment, null);
    assert.doesNotMatch(customerEmail().text, /transferencia/);
    assert.match(customerEmail().text, /confirmar la entrega/);
  });

  test("without SMTP the reservation still goes through and nothing is sent", async () => {
    db.prepare("DELETE FROM config WHERE key LIKE 'smtp_%'").run();
    setConfig("bank_iban", "ES4301824731840201605267");
    const { status, body } = await reserve();
    assert.equal(status, 201);
    assert.equal(body.payment.method, "transfer");
    assert.equal(sent.length, 0);
  });
});
