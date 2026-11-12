import { test, describe, before, beforeEach, after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Throwaway DB before database.js loads, no real Eleventy build behind config writes.
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "bl-site-monei-")), "app.db");
process.env.JWT_SECRET = "test-secret-for-monei";
process.env.BL_SITE_DISABLE_REBUILD = "1";
const API_KEY = "pk_test_unit_test_key";
delete process.env.SITE_URL;

const express = (await import("express")).default;
const nodemailer = (await import("nodemailer")).default;
const db = (await import("../db/database.js")).default;
const moneiRouter = (await import("./monei.js")).default;
const { verifyMoneiSignature } = await import("./monei.js");
const reservationsRouter = (await import("./reservations.js")).default;

let server;
let baseUrl;
let fakeMonei;
let moneiRequests;
let moneiAnswer;
let sent;

before(async () => {
  // A stand-in for api.monei.com: records what the server sends and answers as told.
  fakeMonei = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      moneiRequests.push({ headers: req.headers, body: JSON.parse(body) });
      res.writeHead(moneiAnswer.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(moneiAnswer.json));
    });
  });
  await new Promise((resolve) => fakeMonei.listen(0, resolve));
  process.env.MONEI_API_URL = `http://127.0.0.1:${fakeMonei.address().port}/v1/payments`;

  // Same order as src/server.js: the callback before the global JSON parser.
  const app = express();
  // Each checkout comes from its own address (X-Forwarded-For), so the 10 a
  // minute limit on the public checkout never gets in the way of a test.
  app.set("trust proxy", 1);
  app.use("/api/monei", moneiRouter);
  app.use(express.json());
  app.use("/api/reservations", reservationsRouter);
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  mock.method(nodemailer, "createTransport", () => ({
    sendMail: async (message) => {
      sent.push(message);
    },
  }));
});

after(() => {
  mock.restoreAll();
  server?.close();
  fakeMonei?.close();
});

function setConfig(key, value) {
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(key, value);
}

beforeEach(() => {
  sent = [];
  moneiRequests = [];
  moneiAnswer = {
    status: 200,
    json: { id: "pay_1", status: "PENDING", nextAction: { type: "CONFIRM", redirectUrl: "https://secure.monei.com/payments/pay_1" } },
  };
  process.env.MONEI_API_KEY = API_KEY;
  db.exec(`
    DELETE FROM products; DELETE FROM b2b_accounts; DELETE FROM reservations;
    DELETE FROM reservation_items; DELETE FROM config;
  `);
  db.prepare(
    "INSERT INTO products (sku, slug, name, category, price_cents, stock_qty) VALUES ('A1', 'p-a1', 'Cuaderno', 'Cuadernos', 1210, 5)",
  ).run();
  setConfig("company_name", "Papelería Test");
  setConfig("site_url", "https://tienda.example.com/");
  setConfig("smtp_host", "smtp.example.com");
  setConfig("smtp_user", "web@example.com");
  setConfig("smtp_pass", "secret");
  setConfig("notify_email", "tienda@example.com");
});

let visitor = 0;
const checkout = (extra = {}) =>
  fetch(`${baseUrl}/api/reservations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": `10.1.0.${++visitor}` },
    body: JSON.stringify({
      customer_name: "Ana",
      customer_email: "ana@example.com",
      customer_phone: "612 34 56 78",
      accept_terms: true,
      items: [{ sku: "A1", quantity: 2 }],
      ...extra,
    }),
  });

// What MONEI sends: the raw JSON, signed as "<t>.<body>" with the API key.
function sign(body, { key = API_KEY, t = "1700000000" } = {}) {
  return `t=${t},v1=${createHmac("sha256", key).update(`${t}.${body}`).digest("hex")}`;
}

function callback(payload, header) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  return fetch(`${baseUrl}/api/monei/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(header === null ? {} : { "MONEI-Signature": header ?? sign(body) }) },
    body,
  });
}

// A card reservation already handed to MONEI, as the checkout leaves it.
async function cardReservation() {
  const res = await checkout({ payment_method: "card" });
  assert.equal(res.status, 201);
  return (await res.json()).id;
}

const succeeded = (id, over = {}) => ({
  id: "pay_1",
  orderId: `R${id}`,
  status: "SUCCEEDED",
  amount: 2420,
  currency: "EUR",
  ...over,
});

const row = (id) => db.prepare("SELECT * FROM reservations WHERE id = ?").get(id);

describe("verifyMoneiSignature", () => {
  const body = '{"id":"pay_1","status":"SUCCEEDED"}';

  test("accepts the signature of exactly those bytes", () => {
    assert.equal(verifyMoneiSignature(Buffer.from(body), sign(body), API_KEY), true);
  });

  test("rejects a changed body, another key, a missing header and no key", () => {
    assert.equal(verifyMoneiSignature(Buffer.from(body + " "), sign(body), API_KEY), false);
    assert.equal(verifyMoneiSignature(Buffer.from(body), sign(body, { key: "other" }), API_KEY), false);
    assert.equal(verifyMoneiSignature(Buffer.from(body), undefined, API_KEY), false);
    assert.equal(verifyMoneiSignature(Buffer.from(body), sign(body), ""), false);
  });

  test("ignores schemes other than v1 instead of accepting them", () => {
    const hex = createHmac("sha256", API_KEY).update(`1700000000.${body}`).digest("hex");
    assert.equal(verifyMoneiSignature(Buffer.from(body), `t=1700000000,v0=${hex}`, API_KEY), false);
    assert.equal(verifyMoneiSignature(Buffer.from(body), `t=1700000000,v0=bad,v1=${hex}`, API_KEY), true);
  });
});

describe("POST /api/reservations with payment_method card", () => {
  test("creates the payment server-side and returns MONEI's page, without emailing yet", async () => {
    const res = await checkout({ payment_method: "card" });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.redirect_url, "https://secure.monei.com/payments/pay_1");

    assert.equal(moneiRequests.length, 1);
    const { headers, body } = moneiRequests[0];
    assert.equal(headers.authorization, API_KEY, "the key goes as is, with no Bearer");
    assert.equal(body.amount, 2420, "2 x 12,10 €, priced by the server");
    assert.equal(body.currency, "EUR");
    assert.equal(body.orderId, `R${data.id}`);
    assert.equal(body.callbackUrl, "https://tienda.example.com/api/monei/callback");
    assert.equal(body.completeUrl, "https://tienda.example.com/pedido-recibido");
    assert.equal(body.customer.phone, undefined, "free-text phones are not valid E.164");

    const r = row(data.id);
    assert.equal(r.status, "awaiting_payment");
    assert.equal(r.monei_payment_id, "pay_1");
    assert.equal(r.paid_at, null);
    assert.equal(sent.length, 0, "an unpaid order is not announced");
  });

  test("never trusts an amount sent by the browser", async () => {
    await checkout({ payment_method: "card", total_cents: 1, amount: 1 });
    assert.equal(moneiRequests[0].body.amount, 2420);
  });

  test("is refused when MONEI is not configured", async () => {
    delete process.env.MONEI_API_KEY;
    const res = await checkout({ payment_method: "card" });
    assert.equal(res.status, 400);
    assert.equal(moneiRequests.length, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM reservations").get().n, 0);
  });

  test("is refused when site_url is not https, since MONEI could not call back", async () => {
    setConfig("site_url", "http://tienda.example.com");
    const res = await checkout({ payment_method: "card" });
    assert.equal(res.status, 400);
  });

  test("cancels the order and answers 502 when MONEI fails, without leaking its message", async () => {
    moneiAnswer = { status: 422, json: { message: "internal detail from MONEI" } };
    const res = await checkout({ payment_method: "card" });
    assert.equal(res.status, 502);
    assert.doesNotMatch(JSON.stringify(await res.json()), /internal detail/);
    const only = db.prepare("SELECT * FROM reservations").all();
    assert.equal(only.length, 1);
    assert.equal(only[0].status, "cancelled");
  });

  test("a page that does not ask for card keeps the old behaviour", async () => {
    setConfig("bank_iban", "ES9121000418450200051332");
    const res = await checkout();
    const data = await res.json();
    assert.equal(data.payment.method, "transfer");
    assert.equal(data.redirect_url, undefined);
    assert.equal(moneiRequests.length, 0);
    assert.equal(sent.length, 2, "transfer orders are still announced at once");
  });

  test("payment-options reports what the cart can offer", async () => {
    setConfig("bank_iban", "ES9121000418450200051332");
    assert.deepEqual(await (await fetch(`${baseUrl}/api/reservations/payment-options`)).json(), {
      card: true,
      transfer: true,
    });
    delete process.env.MONEI_API_KEY;
    assert.deepEqual(await (await fetch(`${baseUrl}/api/reservations/payment-options`)).json(), {
      card: false,
      transfer: true,
    });
  });
});

describe("POST /api/monei/callback", () => {
  test("refuses a callback with no signature or a wrong one", async () => {
    const id = await cardReservation();
    assert.equal((await callback(succeeded(id), null)).status, 401);
    assert.equal((await callback(succeeded(id), sign("{}"))).status, 401);
    assert.equal(row(id).paid_at, null);
  });

  test("refuses everything while MONEI is not configured", async () => {
    const id = await cardReservation();
    const body = JSON.stringify(succeeded(id));
    const header = sign(body);
    delete process.env.MONEI_API_KEY;
    assert.equal((await callback(body, header)).status, 401);
  });

  test("a verified SUCCEEDED confirms the order and sends both emails once", async () => {
    const id = await cardReservation();
    const res = await callback(succeeded(id));
    assert.equal(res.status, 200);
    const r = row(id);
    assert.equal(r.status, "confirmed");
    assert.ok(r.paid_at);
    assert.equal(sent.length, 2);
    const owner = sent.find((m) => m.to === "tienda@example.com");
    const customer = sent.find((m) => m.to === "ana@example.com");
    assert.match(owner.text, /con tarjeta/);
    assert.match(owner.text, /2 x Cuaderno/);
    assert.match(customer.text, /Hemos recibido tu pago con tarjeta/);
  });

  test("MONEI retrying the same callback changes nothing and sends nothing", async () => {
    const id = await cardReservation();
    await callback(succeeded(id));
    const paidAt = row(id).paid_at;
    sent = [];
    assert.equal((await callback(succeeded(id))).status, 200);
    assert.equal(row(id).paid_at, paidAt);
    assert.equal(sent.length, 0);
  });

  test("a payment of another amount is not applied", async () => {
    const id = await cardReservation();
    const res = await callback(succeeded(id, { amount: 1 }));
    assert.equal(res.status, 200, "retrying cannot fix it, so MONEI is told it arrived");
    assert.equal(row(id).paid_at, null);
    assert.equal(row(id).status, "awaiting_payment");
    assert.equal(sent.length, 0);
  });

  test("a signed payment id that is not the order's cannot confirm it", async () => {
    const id = await cardReservation();
    assert.equal((await callback(succeeded(id, { id: "pay_other" }))).status, 404);
    assert.equal((await callback(succeeded(9999))).status, 404);
    assert.equal(row(id).paid_at, null);
  });

  test("FAILED, CANCELED and EXPIRED cancel an unpaid order", async () => {
    for (const status of ["FAILED", "CANCELED", "EXPIRED"]) {
      const id = await cardReservation();
      await callback(succeeded(id, { status }));
      assert.equal(row(id).status, "cancelled", status);
      assert.equal(sent.length, 0);
    }
  });

  test("a failure after the payment succeeded does not undo it", async () => {
    const id = await cardReservation();
    await callback(succeeded(id));
    await callback(succeeded(id, { status: "FAILED" }));
    assert.equal(row(id).status, "confirmed");
  });

  test("a late success on an order that was cancelled still counts", async () => {
    const id = await cardReservation();
    await callback(succeeded(id, { status: "EXPIRED" }));
    await callback(succeeded(id));
    assert.equal(row(id).status, "confirmed");
    assert.ok(row(id).paid_at);
  });

  test("statuses that are not an outcome are acknowledged and ignored", async () => {
    const id = await cardReservation();
    assert.equal((await callback(succeeded(id, { status: "PENDING" }))).status, 200);
    assert.equal(row(id).status, "awaiting_payment");
  });
});
