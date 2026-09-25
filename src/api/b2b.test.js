import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// database.js resolves DB_PATH at import time and refuses to start if it lands
// in a served directory, so point it at a throwaway dir before anything that
// imports it is loaded. Toggling b2b_enabled goes through setConfig, which
// would otherwise schedule a real Eleventy build of this throwaway database.
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "bl-site-b2b-")), "app.db");
process.env.JWT_SECRET = "test-secret-for-b2b";
process.env.BL_SITE_DISABLE_REBUILD = "1";

const express = (await import("express")).default;
const jwt = (await import("jsonwebtoken")).default;
const db = (await import("../db/database.js")).default;
const { getConfig } = await import("../db/database.js");
const { requireAuth } = await import("../middleware/auth.js");
const b2bRouter = (await import("./b2b.js")).default;
const { b2bPriceCents, hashPassword, verifyPassword } = await import("./b2b.js");
const reservationsRouter = (await import("./reservations.js")).default;

const ADMIN = { Authorization: `Bearer ${jwt.sign({ role: "admin" }, process.env.JWT_SECRET)}` };

let server;
let baseUrl;

before(async () => {
  const app = express();
  // The login limiter allows 10 attempts per IP. This suite signs in far more
  // often than that, so each login() claims its own address.
  app.set("trust proxy", true);
  app.use(express.json());
  app.use("/api/b2b", b2bRouter);
  app.use("/api/reservations", reservationsRouter);
  app.get("/admin-only", requireAuth, (req, res) => res.json({ ok: true }));
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

function setFlag(key, value) {
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(key, value);
}

function seedProduct(sku, category, price_cents) {
  db.prepare(
    `INSERT INTO products (sku, slug, name, category, price_cents, stock_qty)
     VALUES (?, ?, ?, ?, ?, 5)`,
  ).run(sku, `p-${sku}`, `Producto ${sku}`, category, price_cents);
}

function seedAccount(email = "compras@acme.es", password = "secreto-123", active = 1) {
  return db
    .prepare(
      "INSERT INTO b2b_accounts (company_name, tax_id, email, password_hash, active) VALUES (?, ?, ?, ?, ?)",
    )
    .run("ACME S.L.", "B12345678", email, hashPassword(password), active).lastInsertRowid;
}

const api = (path, { method = "GET", body, headers = {} } = {}) =>
  fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

let loginIp = 0;
async function login(email = "compras@acme.es", password = "secreto-123") {
  loginIp += 1;
  const res = await api("/api/b2b/login", {
    method: "POST",
    body: { email, password },
    headers: { "X-Forwarded-For": `10.0.${Math.floor(loginIp / 250)}.${loginIp % 250}` },
  });
  const setCookie = res.headers.get("set-cookie") || "";
  return { res, cookie: setCookie.split(";")[0] };
}

function reserve(items, headers = {}) {
  return api("/api/reservations", {
    method: "POST",
    headers,
    body: { customer_name: "Ana", customer_email: "ana@acme.es", items },
  });
}

beforeEach(() => {
  db.exec(`
    DELETE FROM products; DELETE FROM b2b_accounts; DELETE FROM b2b_category_discounts;
    DELETE FROM reservations; DELETE FROM reservation_items;
  `);
  setFlag("b2b_enabled", "1");
  setFlag("b2b_default_discount_pct", "0");
});

describe("B2B pricing arithmetic", () => {
  test("rounds to the cent the same way web/cart.js does", () => {
    assert.equal(b2bPriceCents(1000, 15), 850);
    assert.equal(b2bPriceCents(999, 12.5), 874); // 874.125
    assert.equal(b2bPriceCents(1999, 0), 1999);
  });

  test("passwords are hashed, and verify only against themselves", () => {
    const stored = hashPassword("secreto-123");
    assert.ok(stored.startsWith("scrypt:"));
    assert.ok(!stored.includes("secreto-123"));
    assert.equal(verifyPassword("secreto-123", stored), true);
    assert.equal(verifyPassword("secreto-124", stored), false);
    assert.equal(verifyPassword("secreto-123", "garbage"), false);
  });
});

describe("B2B session", () => {
  test("login is rate limited per address", async () => {
    seedAccount();
    const attempt = () =>
      api("/api/b2b/login", {
        method: "POST",
        body: { email: "compras@acme.es", password: "wrong-wrong" },
        headers: { "X-Forwarded-For": "192.0.2.1" },
      });
    for (let i = 0; i < 10; i++) assert.equal((await attempt()).status, 401);
    assert.equal((await attempt()).status, 429);
  });

  test("a good login sets an httpOnly session cookie and /me answers with the discounts", async () => {
    seedAccount();
    db.prepare("INSERT INTO b2b_category_discounts (category, discount_pct) VALUES ('Cuadernos', 20)").run();
    setFlag("b2b_default_discount_pct", "5");

    const { res, cookie } = await login();
    assert.equal(res.status, 200);
    assert.match(res.headers.get("set-cookie"), /HttpOnly/);
    assert.match(res.headers.get("set-cookie"), /SameSite=Lax/);

    const me = await api("/api/b2b/me", { headers: { Cookie: cookie } });
    assert.equal(me.status, 200);
    const data = await me.json();
    assert.equal(data.account.company_name, "ACME S.L.");
    assert.equal(data.default_pct, 5);
    assert.deepEqual(data.discounts, { Cuadernos: 20 });
    assert.equal(data.account.password_hash, undefined);
  });

  test("the email is matched case-insensitively", async () => {
    seedAccount();
    const { res } = await login("Compras@ACME.es");
    assert.equal(res.status, 200);
  });

  test("a wrong password and an unknown email get the same answer", async () => {
    seedAccount();
    const wrong = await login("compras@acme.es", "nope-nope-nope");
    const unknown = await login("nadie@acme.es", "nope-nope-nope");
    assert.equal(wrong.res.status, 401);
    assert.equal(unknown.res.status, 401);
    assert.deepEqual(await wrong.res.json(), await unknown.res.json());
  });

  test("a deactivated account cannot sign in", async () => {
    seedAccount("compras@acme.es", "secreto-123", 0);
    const { res } = await login();
    assert.equal(res.status, 403);
  });

  test("deactivating an account ends its existing session on the next request", async () => {
    const id = seedAccount();
    const { cookie } = await login();
    db.prepare("UPDATE b2b_accounts SET active = 0 WHERE id = ?").run(id);
    const me = await api("/api/b2b/me", { headers: { Cookie: cookie } });
    assert.equal(me.status, 401);
  });

  test("switching the area off refuses logins and ends sessions", async () => {
    seedAccount();
    const { cookie } = await login();
    setFlag("b2b_enabled", "0");
    assert.equal((await login()).res.status, 404);
    assert.equal((await api("/api/b2b/me", { headers: { Cookie: cookie } })).status, 401);
  });

  // The one that matters most. requireAuth — and the inline checks in
  // products.js and blog.js — take any token signed with jwt_secret as a panel
  // admin. A B2B session must not be one, however it is presented.
  test("a B2B session is never accepted as a panel login", async () => {
    seedAccount();
    const { cookie } = await login();
    const token = decodeURIComponent(cookie.split("=")[1]);
    assert.ok(token);

    for (const headers of [
      { Cookie: cookie },
      { Authorization: `Bearer ${token}` },
      { "x-panel-token": token },
    ]) {
      const res = await api("/admin-only", { headers });
      assert.equal(res.status, 401, JSON.stringify(Object.keys(headers)));
    }
    assert.throws(() => jwt.verify(token, process.env.JWT_SECRET));
  });

  test("a panel token is not a B2B session either", async () => {
    const adminToken = ADMIN.Authorization.slice(7);
    const me = await api("/api/b2b/me", { headers: { Cookie: `bl_b2b=${adminToken}` } });
    assert.equal(me.status, 401);
  });
});

describe("reservations are priced for whoever places them", () => {
  beforeEach(() => {
    seedProduct("A1", "Cuadernos", 1000);
    seedProduct("B2", "Bolígrafos", 2000);
    seedProduct("C3", "", 500);
    db.prepare("INSERT INTO b2b_category_discounts (category, discount_pct) VALUES ('Cuadernos', 20)").run();
    // An explicit 0 overrides the general discount.
    db.prepare("INSERT INTO b2b_category_discounts (category, discount_pct) VALUES ('Bolígrafos', 0)").run();
    setFlag("b2b_default_discount_pct", "10");
  });

  const items = [
    { sku: "A1", quantity: 2 },
    { sku: "B2", quantity: 1 },
    { sku: "C3", quantity: 1 },
  ];

  test("an anonymous visitor pays retail", async () => {
    const res = await reserve(items);
    const data = await res.json();
    assert.equal(res.status, 201);
    assert.equal(data.total_cents, 2 * 1000 + 2000 + 500);
    assert.equal(data.b2b, false);
    const row = db.prepare("SELECT * FROM reservations WHERE id = ?").get(data.id);
    assert.equal(row.b2b_account_id, null);
  });

  test("a signed-in account pays the category price, the general one elsewhere", async () => {
    const id = seedAccount();
    const { cookie } = await login();
    const res = await reserve(items, { Cookie: cookie });
    const data = await res.json();
    assert.equal(res.status, 201);
    // 2 × 800 (−20 %) + 2000 (explicit 0 %) + 450 (general −10 %)
    assert.equal(data.total_cents, 1600 + 2000 + 450);
    assert.equal(data.b2b, true);

    const row = db.prepare("SELECT * FROM reservations WHERE id = ?").get(data.id);
    assert.equal(row.b2b_account_id, id);
    assert.equal(row.b2b_company, "ACME S.L.");
    const lines = db
      .prepare("SELECT sku, unit_price_cents FROM reservation_items WHERE reservation_id = ? ORDER BY sku")
      .all(data.id);
    assert.deepEqual(lines.map((l) => [l.sku, l.unit_price_cents]), [
      ["A1", 800],
      ["B2", 2000],
      ["C3", 450],
    ]);
  });

  test("a deactivated account pays retail even with a live cookie", async () => {
    const id = seedAccount();
    const { cookie } = await login();
    db.prepare("UPDATE b2b_accounts SET active = 0 WHERE id = ?").run(id);
    const data = await (await reserve(items, { Cookie: cookie })).json();
    assert.equal(data.total_cents, 4500);
    assert.equal(data.b2b, false);
  });

  test("a forged cookie pays retail", async () => {
    seedAccount();
    const forged = jwt.sign({ sub: "1", typ: "b2b" }, "not-the-key");
    const data = await (await reserve(items, { Cookie: `bl_b2b=${forged}` })).json();
    assert.equal(data.total_cents, 4500);
  });
});

describe("panel: discounts", () => {
  test("lists live categories with counts, and orphaned discounts too", async () => {
    seedProduct("A1", "Cuadernos", 1000);
    seedProduct("A2", "Cuadernos", 1000);
    seedProduct("B2", "Bolígrafos", 2000);
    db.prepare("INSERT INTO b2b_category_discounts (category, discount_pct) VALUES ('Cuadernos', 20)").run();
    db.prepare("INSERT INTO b2b_category_discounts (category, discount_pct) VALUES ('Agendas', 5)").run();

    const data = await (await api("/api/b2b/discounts", { headers: ADMIN })).json();
    assert.deepEqual(data.categories, [
      { category: "Agendas", total: 0, discount_pct: 5 },
      { category: "Bolígrafos", total: 1, discount_pct: null },
      { category: "Cuadernos", total: 2, discount_pct: 20 },
    ]);
  });

  test("writes are partial: absent is left alone, null or empty clears", async () => {
    db.prepare("INSERT INTO b2b_category_discounts (category, discount_pct) VALUES ('Cuadernos', 20)").run();
    db.prepare("INSERT INTO b2b_category_discounts (category, discount_pct) VALUES ('Agendas', 5)").run();

    const res = await api("/api/b2b/discounts", {
      method: "PUT",
      headers: ADMIN,
      body: { discounts: { Agendas: null, Bolígrafos: "12,5", Papel: 0 } },
    });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).discounts, { Cuadernos: 20, Bolígrafos: 12.5, Papel: 0 });
  });

  test("one bad value rejects the whole request and writes nothing", async () => {
    // "" is not in the list: it means "clear", not "invalid".
    for (const bad of [100, -1, "abc", true]) {
      const res = await api("/api/b2b/discounts", {
        method: "PUT",
        headers: ADMIN,
        body: { discounts: { Cuadernos: 10, Agendas: bad } },
      });
      assert.equal(res.status, 400, String(bad));
    }
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM b2b_category_discounts").get().n, 0);
  });

  test("requires the panel login", async () => {
    assert.equal((await api("/api/b2b/discounts")).status, 401);
    assert.equal((await api("/api/b2b/accounts")).status, 401);
    assert.equal((await api("/api/b2b/settings", { method: "PUT", body: { enabled: true } })).status, 401);
  });
});

describe("panel: settings", () => {
  test("switches the area and sets the general discount", async () => {
    setFlag("b2b_enabled", "0");
    const res = await api("/api/b2b/settings", {
      method: "PUT",
      headers: ADMIN,
      body: { enabled: true, default_pct: "7.5" },
    });
    assert.deepEqual(await res.json(), { success: true, enabled: true, default_pct: 7.5 });
    assert.equal(getConfig("b2b_enabled"), "1");

    const bad = await api("/api/b2b/settings", { method: "PUT", headers: ADMIN, body: { default_pct: 150 } });
    assert.equal(bad.status, 400);
    assert.equal(getConfig("b2b_default_discount_pct"), "7.5");
  });
});

describe("panel: accounts", () => {
  test("creates an account that can then sign in, and never returns the hash", async () => {
    const res = await api("/api/b2b/accounts", {
      method: "POST",
      headers: ADMIN,
      body: { company_name: "ACME S.L.", email: "Compras@Acme.es", password: "secreto-123" },
    });
    assert.equal(res.status, 201);
    const { account } = await res.json();
    assert.equal(account.email, "compras@acme.es");
    assert.equal(account.password_hash, undefined);
    assert.equal((await login()).res.status, 200);

    const list = await (await api("/api/b2b/accounts", { headers: ADMIN })).json();
    assert.equal(list.accounts.length, 1);
    assert.equal(list.accounts[0].password_hash, undefined);
  });

  test("rejects a duplicate email, a short password and a missing company", async () => {
    seedAccount();
    const dup = await api("/api/b2b/accounts", {
      method: "POST",
      headers: ADMIN,
      body: { company_name: "Otra", email: "compras@acme.es", password: "secreto-123" },
    });
    assert.equal(dup.status, 409);
    const short = await api("/api/b2b/accounts", {
      method: "POST",
      headers: ADMIN,
      body: { company_name: "Otra", email: "otra@acme.es", password: "corta" },
    });
    assert.equal(short.status, 400);
    const noCompany = await api("/api/b2b/accounts", {
      method: "POST",
      headers: ADMIN,
      body: { email: "otra@acme.es", password: "secreto-123" },
    });
    assert.equal(noCompany.status, 400);
  });

  test("an update is partial and only changes the password when one is sent", async () => {
    const id = seedAccount();
    const before = db.prepare("SELECT password_hash FROM b2b_accounts WHERE id = ?").get(id);
    await api(`/api/b2b/accounts/${id}`, { method: "PUT", headers: ADMIN, body: { phone: "600111222" } });
    const after = db.prepare("SELECT * FROM b2b_accounts WHERE id = ?").get(id);
    assert.equal(after.phone, "600111222");
    assert.equal(after.company_name, "ACME S.L.");
    assert.equal(after.password_hash, before.password_hash);

    await api(`/api/b2b/accounts/${id}`, { method: "PUT", headers: ADMIN, body: { password: "otra-clave-9" } });
    assert.equal((await login()).res.status, 401);
    assert.equal((await login("compras@acme.es", "otra-clave-9")).res.status, 200);
  });

  test("deleting an account keeps who its past reservations were for", async () => {
    seedProduct("A1", "Cuadernos", 1000);
    const id = seedAccount();
    const { cookie } = await login();
    const { id: reservationId } = await (await reserve([{ sku: "A1", quantity: 1 }], { Cookie: cookie })).json();

    const res = await api(`/api/b2b/accounts/${id}`, { method: "DELETE", headers: ADMIN });
    assert.equal(res.status, 200);
    const row = db.prepare("SELECT b2b_company FROM reservations WHERE id = ?").get(reservationId);
    assert.equal(row.b2b_company, "ACME S.L.");
  });
});
