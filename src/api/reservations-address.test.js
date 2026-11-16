import { test, describe, before, beforeEach, after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Same throwaway-DB setup as reservations-shipping.test.js: DB_PATH before
// database.js loads, no real Eleventy build behind config writes.
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "bl-site-reservations-address-")), "app.db");
process.env.JWT_SECRET = "test-secret-for-address";
process.env.BL_SITE_DISABLE_REBUILD = "1";

const express = (await import("express")).default;
const nodemailer = (await import("nodemailer")).default;
const db = (await import("../db/database.js")).default;
const reservationsRouter = (await import("./reservations.js")).default;
const { formatShippingAddress } = await import("../shipping.js");

let server;
let baseUrl;
let sent;

// Just enough checkouts per minute for this file (the public limit is 10).
before(async () => {
  const app = express();
  app.use(express.json());
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
});

function reserve(extra = {}) {
  return fetch(`${baseUrl}/api/reservations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      customer_name: "Ana",
      customer_email: "ana@cliente.es",
      items: [{ sku: "A1", quantity: 2 }],
      accept_terms: true,
      ...extra,
    }),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
}

const ZONES = JSON.stringify([{ id: "peninsula", label: "Península", price_cents: 700 }]);

const ownerEmail = () => sent.find((m) => m.to === "tienda@example.com");
const customerEmail = () => sent.find((m) => m.to === "ana@cliente.es");

const ADDRESS = {
  address: "CALLE ALCALA 50",
  address_extra: "2ºB",
  postal_code: "28014",
  city: "Madrid",
};

describe("delivery address at checkout", () => {
  test("with shipping zones the address is required, and nothing is stored without it", async () => {
    setConfig("shipping_zones", ZONES);
    const { status, body } = await reserve({ shipping_zone: "peninsula" });
    assert.equal(status, 400);
    assert.equal(
      body.error,
      "Escribe tu dirección de entrega: calle y número, código postal y localidad (si no ves los campos, recarga la página).",
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM reservations").get().n, 0);
  });

  test("a valid address is stored as one formatted line", async () => {
    setConfig("shipping_zones", ZONES);
    const { status, body } = await reserve({ shipping_zone: "peninsula", ...ADDRESS });
    assert.equal(status, 201);
    const row = db.prepare("SELECT shipping_address FROM reservations WHERE id = ?").get(body.id);
    assert.equal(row.shipping_address, "CALLE ALCALA 50, 2ºB, 28014 Madrid");
  });

  test("both emails carry the address", async () => {
    setConfig("shipping_zones", ZONES);
    await reserve({ shipping_zone: "peninsula", ...ADDRESS });
    assert.match(ownerEmail().text, /Dirección de envío: CALLE ALCALA 50, 2ºB, 28014 Madrid/);
    assert.match(customerEmail().text, /Dirección de entrega:\nCALLE ALCALA 50, 2ºB, 28014 Madrid\n\n/);
  });

  test("a newline in the address cannot start a new line in an email", async () => {
    setConfig("shipping_zones", ZONES);
    const { status, body } = await reserve({
      shipping_zone: "peninsula",
      address: "Calle X 1\nBcc: a@b.c",
      postal_code: "28014",
      city: "Madrid",
    });
    assert.equal(status, 201);
    const row = db.prepare("SELECT shipping_address FROM reservations WHERE id = ?").get(body.id);
    assert.equal(row.shipping_address, "Calle X 1 Bcc: a@b.c, 28014 Madrid");
    assert.doesNotMatch(row.shipping_address, /\n/);
    for (const mail of [ownerEmail(), customerEmail()]) {
      assert.doesNotMatch(mail.text, /^Bcc:/m);
    }
  });

  test("a Portuguese postal code is accepted", async () => {
    setConfig("shipping_zones", ZONES);
    const { status, body } = await reserve({
      shipping_zone: "peninsula",
      address: "Rua Augusta 10",
      postal_code: "1000-001",
      city: "Lisboa",
    });
    assert.equal(status, 201);
    const row = db.prepare("SELECT shipping_address FROM reservations WHERE id = ?").get(body.id);
    assert.equal(row.shipping_address, "Rua Augusta 10, 1000-001 Lisboa");
  });

  test("with no zones configured the address is still required", async () => {
    const { status, body } = await reserve();
    assert.equal(status, 400);
    assert.equal(
      body.error,
      "Escribe tu dirección de entrega: calle y número, código postal y localidad (si no ves los campos, recarga la página).",
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM reservations").get().n, 0);
  });

  test("with no zones configured a valid address is accepted and stored", async () => {
    const { status, body } = await reserve(ADDRESS);
    assert.equal(status, 201);
    const row = db.prepare("SELECT shipping_address FROM reservations WHERE id = ?").get(body.id);
    assert.equal(row.shipping_address, "CALLE ALCALA 50, 2ºB, 28014 Madrid");
  });
});

describe("formatShippingAddress", () => {
  test("joins street, extra, postal code and town on one line", () => {
    assert.equal(
      formatShippingAddress({ address: "CALLE ALCALA 50", extra: "2ºB", postal_code: "28014", city: "Madrid" }),
      "CALLE ALCALA 50, 2ºB, 28014 Madrid",
    );
  });

  test("drops an empty extra and any other empty part", () => {
    assert.equal(
      formatShippingAddress({ address: "CALLE ALCALA 50", extra: "", postal_code: "28014", city: "Madrid" }),
      "CALLE ALCALA 50, 28014 Madrid",
    );
    assert.equal(
      formatShippingAddress({ address: "CALLE ALCALA 50", extra: "", postal_code: "", city: "Madrid" }),
      "CALLE ALCALA 50, Madrid",
    );
    assert.equal(formatShippingAddress({}), "");
  });
});
