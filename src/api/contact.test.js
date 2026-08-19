import { test, describe, before, beforeEach, after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "bl-site-contact-")), "app.db");
process.env.JWT_SECRET = "test-secret-for-contact";

const express = (await import("express")).default;
const db = (await import("../db/database.js")).default;
const contactRouter = (await import("./contact.js")).default;

function setRawConfig(key, value) {
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(key, value);
}

let server;
let baseUrl;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/contact", contactRouter);
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
  db.prepare("DELETE FROM contact_messages").run();
});

function post(body) {
  return fetch(baseUrl + "/api/contact", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = { name: "Ada", email: "ada@example.com", message: "Hola" };

describe("POST /api/contact — Turnstile", () => {
  test("submits fine with no token when Turnstile isn't configured", async () => {
    const res = await post(VALID_BODY);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).success, true);
  });

  test("rejects a missing token once Turnstile is configured", async () => {
    setRawConfig("turnstile_site_key", "site-key");
    setRawConfig("turnstile_secret_key", "secret-key");

    const res = await post(VALID_BODY);
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

    const res = await post({ ...VALID_BODY, turnstile_token: "bad-token" });
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

    const res = await post({ ...VALID_BODY, turnstile_token: "good-token" });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).success, true);

    fetchMock.mock.restore();
  });
});
