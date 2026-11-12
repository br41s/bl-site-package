// The terms, privacy and cookies pages describe what the code does, so they must
// change with card payment (src/api/monei.js): «Este sitio no admite pagos con
// tarjeta» becomes false the moment MONEI is on, and a deploy without MONEI must
// not mention a payment provider it does not use. Both are checked through a
// real build of the templates, as in src/build/calida-sections.test.js.
//
// Lives in src/ and NOT next to the files it covers: see the guard in
// src/build/no-tests-in-site.test.js.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.BL_SITE_DISABLE_REBUILD = "1";
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "bl-site-legal-card-")), "app.db");
delete process.env.MONEI_API_KEY;
delete process.env.SITE_URL;

const db = (await import("../db/database.js")).default;
const root = join(import.meta.dirname, "../..");

function setConfig(key, value) {
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(key, value);
}

// A real build into a throwaway directory, with the given environment on top of
// what the database holds. Returns a reader for the built files.
function build(env = {}) {
  const out = mkdtempSync(join(tmpdir(), "bl-site-legal-card-out-"));
  const r = spawnSync(process.execPath, [join(root, "src/build/eleventy-child.js"), out], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `build failed:\n${r.stderr}\n${r.stdout}`);
  return (file) => readFileSync(join(out, file), "utf8");
}

const PAGES = ["condiciones.html", "privacidad.html", "cookies.html"];
const CARD_ENV = { MONEI_API_KEY: "pk_test_build_check", SITE_URL: "https://tienda.example.com" };

before(() => {
  db.exec("DELETE FROM products; DELETE FROM config;");
  // A catalogue is what makes the terms, the order sections and the cart exist.
  db.prepare(
    "INSERT INTO products (sku, slug, name, category, price_cents, stock_qty) VALUES ('A1', 'p-a1', 'Cuaderno', 'Cuadernos', 1210, 5)",
  ).run();
  setConfig("company_name", "Papelería Test");
  setConfig("site_url", "https://tienda.example.com");
  setConfig("bank_iban", "ES9121000418450200051332");
});

describe("legal pages without card payment", () => {
  let read;
  before(() => {
    read = build();
  });

  test("keep saying the site takes no card payments and name no payment provider", () => {
    assert.match(read("condiciones.html"), /no admite pagos con tarjeta/);
    for (const page of PAGES) assert.doesNotMatch(read(page), /MONEI/, page);
  });

  test("keep their original date and the transfer-only wording", () => {
    for (const page of PAGES) assert.match(read(page), /Última actualización: 2 de octubre de 2026/, page);
    assert.match(read("condiciones.html"), /El pago se hace por\s*<strong>transferencia bancaria/);
    assert.match(read("condiciones.html"), /por transferencia a la cuenta que nos indiques/);
  });
});

describe("legal pages with card payment", () => {
  let read;
  before(() => {
    read = build(CARD_ENV);
  });

  test("no longer deny card payments, and name the provider on all three pages", () => {
    assert.doesNotMatch(read("condiciones.html"), /no admite pagos con tarjeta/);
    for (const page of PAGES) assert.match(read(page), /MONEI/, page);
  });

  test("the terms say the card data never reach the business and refunds go back the same way", () => {
    const terms = read("condiciones.html");
    assert.match(terms, /nosotros no los recibimos ni los guardamos/);
    assert.match(terms, /por el mismo medio de pago que hayas utilizado/);
    assert.doesNotMatch(terms, /por transferencia a la cuenta que nos indiques/);
  });

  test("transfer stays offered as an alternative while there are bank details", () => {
    assert.match(read("condiciones.html"), /También puedes pagar\s*por\s*<strong>transferencia bancaria/);
  });

  test("are dated from this change", () => {
    for (const page of PAGES) assert.match(read(page), /Última actualización: 12 de noviembre de 2026/, page);
  });

  test("an http site_url keeps card off, since MONEI could not call back", () => {
    const http = build({ ...CARD_ENV, SITE_URL: "http://tienda.example.com" });
    assert.doesNotMatch(http("condiciones.html"), /MONEI/);
  });
});

describe("legal pages with card payment and no bank details", () => {
  test("card is the only way to pay: no transfer, no pay-on-delivery line", () => {
    setConfig("bank_iban", "");
    const read = build(CARD_ENV);
    const terms = read("condiciones.html");
    assert.doesNotMatch(terms, /transferencia bancaria/);
    assert.doesNotMatch(terms, /en el momento de la entrega o de la recogida/);
    assert.match(terms, /con tarjeta/);
  });
});
