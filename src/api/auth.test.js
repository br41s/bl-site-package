import { test, describe, before, beforeEach, afterEach, after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "bl-site-auth-")), "app.db");
process.env.JWT_SECRET = "test-secret-for-auth";
process.env.PANEL_PASSWORD = "correct-horse-battery-staple";

const express = (await import("express")).default;
const db = (await import("../db/database.js")).default;
const authRouter = (await import("./auth.js")).default;

function setRawConfig(key, value) {
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(key, value);
}

let server;
let baseUrl;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRouter);
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
});

function login(body) {
  return fetch(baseUrl + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = { password: "correct-horse-battery-staple" };

describe("GET /api/auth/config", () => {
  test("exposes an empty site key when Turnstile isn't configured", async () => {
    const res = await fetch(baseUrl + "/api/auth/config");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { turnstile_site_key: "" });
  });

  test("exposes the site key, never the secret key", async () => {
    setRawConfig("turnstile_site_key", "site-key");
    setRawConfig("turnstile_secret_key", "secret-key");

    const res = await fetch(baseUrl + "/api/auth/config");
    const data = await res.json();
    assert.equal(data.turnstile_site_key, "site-key");
    assert.equal(data.turnstile_secret_key, undefined);
  });
});

describe("POST /api/auth/login — Turnstile", () => {
  test("logs in fine with no token when Turnstile isn't configured", async () => {
    const res = await login(VALID_BODY);
    assert.equal(res.status, 200);
    assert.ok((await res.json()).token);
  });

  test("rejects a missing token once Turnstile is configured, even with the right password", async () => {
    setRawConfig("turnstile_site_key", "site-key");
    setRawConfig("turnstile_secret_key", "secret-key");

    const res = await login(VALID_BODY);
    assert.equal(res.status, 400);
  });

  test("rejects a token Cloudflare doesn't verify", async () => {
    setRawConfig("turnstile_site_key", "site-key");
    setRawConfig("turnstile_secret_key", "secret-key");
    const realFetch = globalThis.fetch;
    const fetchMock = mock.method(globalThis, "fetch", async (url, opts) => {
      if (typeof url === "string" && url.includes("challenges.cloudflare.com")) {
        return { json: async () => ({ success: false }) };
      }
      return realFetch(url, opts);
    });

    const res = await login({ ...VALID_BODY, turnstile_token: "bad-token" });
    assert.equal(res.status, 400);

    fetchMock.mock.restore();
  });

  test("accepts a token Cloudflare verifies", async () => {
    setRawConfig("turnstile_site_key", "site-key");
    setRawConfig("turnstile_secret_key", "secret-key");
    const realFetch = globalThis.fetch;
    const fetchMock = mock.method(globalThis, "fetch", async (url, opts) => {
      if (typeof url === "string" && url.includes("challenges.cloudflare.com")) {
        return { json: async () => ({ success: true }) };
      }
      return realFetch(url, opts);
    });

    const res = await login({ ...VALID_BODY, turnstile_token: "good-token" });
    assert.equal(res.status, 200);
    assert.ok((await res.json()).token);

    fetchMock.mock.restore();
  });

  test("a verified token still isn't enough with the wrong password", async () => {
    setRawConfig("turnstile_site_key", "site-key");
    setRawConfig("turnstile_secret_key", "secret-key");
    const realFetch = globalThis.fetch;
    const fetchMock = mock.method(globalThis, "fetch", async (url, opts) => {
      if (typeof url === "string" && url.includes("challenges.cloudflare.com")) {
        return { json: async () => ({ success: true }) };
      }
      return realFetch(url, opts);
    });

    const res = await login({ password: "wrong", turnstile_token: "good-token" });
    assert.equal(res.status, 401);

    fetchMock.mock.restore();
  });
});

describe("POST /api/auth/login — rental automation bypass", () => {
  const originalKey = process.env.RENTAL_AUTOMATION_KEY;

  afterEach(() => {
    if (originalKey === undefined) delete process.env.RENTAL_AUTOMATION_KEY;
    else process.env.RENTAL_AUTOMATION_KEY = originalKey;
  });

  function loginWithKey(body, key) {
    return fetch(baseUrl + "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Automation-Key": key },
      body: JSON.stringify(body),
    });
  }

  test("skips Turnstile with no token when the automation key matches", async () => {
    setRawConfig("turnstile_site_key", "site-key");
    setRawConfig("turnstile_secret_key", "secret-key");
    process.env.RENTAL_AUTOMATION_KEY = "rental-shared-secret";

    const res = await loginWithKey(VALID_BODY, "rental-shared-secret");
    assert.equal(res.status, 200);
    assert.ok((await res.json()).token);
  });

  test("still enforces Turnstile when the automation key is wrong", async () => {
    setRawConfig("turnstile_site_key", "site-key");
    setRawConfig("turnstile_secret_key", "secret-key");
    process.env.RENTAL_AUTOMATION_KEY = "rental-shared-secret";

    const res = await loginWithKey(VALID_BODY, "not-the-secret");
    assert.equal(res.status, 400);
  });

  test("a matching automation key still isn't enough with the wrong password", async () => {
    setRawConfig("turnstile_site_key", "site-key");
    setRawConfig("turnstile_secret_key", "secret-key");
    process.env.RENTAL_AUTOMATION_KEY = "rental-shared-secret";

    const res = await loginWithKey({ password: "wrong" }, "rental-shared-secret");
    assert.equal(res.status, 401);
  });

  test("an unconfigured automation key never matches an empty header", async () => {
    setRawConfig("turnstile_site_key", "site-key");
    setRawConfig("turnstile_secret_key", "secret-key");
    delete process.env.RENTAL_AUTOMATION_KEY;

    const res = await loginWithKey(VALID_BODY, "");
    assert.equal(res.status, 400);
  });
});
