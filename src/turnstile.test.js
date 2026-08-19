import { test, describe, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "bl-site-turnstile-")), "app.db");
process.env.JWT_SECRET = "test-secret-for-turnstile";

const db = (await import("./db/database.js")).default;
const {
  getTurnstileSettings,
  isTurnstileConfigured,
  verifyTurnstileToken,
} = await import("./turnstile.js");

function setRawConfig(key, value) {
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(key, value);
}

beforeEach(() => {
  db.prepare("DELETE FROM config").run();
  delete process.env.TURNSTILE_SITE_KEY;
  delete process.env.TURNSTILE_SECRET_KEY;
});

describe("getTurnstileSettings", () => {
  test("reads from the panel config when no env override is set", () => {
    setRawConfig("turnstile_site_key", "site-from-db");
    setRawConfig("turnstile_secret_key", "secret-from-db");
    const settings = getTurnstileSettings();
    assert.equal(settings.siteKey, "site-from-db");
    assert.equal(settings.secretKey, "secret-from-db");
  });

  test("an env var overrides the panel config", () => {
    setRawConfig("turnstile_site_key", "site-from-db");
    process.env.TURNSTILE_SITE_KEY = "site-from-env";
    assert.equal(getTurnstileSettings().siteKey, "site-from-env");
  });
});

describe("isTurnstileConfigured", () => {
  test("false when neither key is set", () => {
    assert.equal(isTurnstileConfigured(), false);
  });

  test("false when only the site key is set", () => {
    setRawConfig("turnstile_site_key", "site-only");
    assert.equal(isTurnstileConfigured(), false);
  });

  test("true once both keys are set", () => {
    setRawConfig("turnstile_site_key", "site-key");
    setRawConfig("turnstile_secret_key", "secret-key");
    assert.equal(isTurnstileConfigured(), true);
  });
});

describe("verifyTurnstileToken", () => {
  test("rejects without calling out when the token is empty", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => {
      throw new Error("should not be called");
    });
    const ok = await verifyTurnstileToken("", { secretKey: "s" });
    assert.equal(ok, false);
    assert.equal(fetchMock.mock.callCount(), 0);
    fetchMock.mock.restore();
  });

  test("true when Cloudflare reports success", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => ({
      json: async () => ({ success: true }),
    }));
    const ok = await verifyTurnstileToken("good-token", { secretKey: "s" });
    assert.equal(ok, true);
    fetchMock.mock.restore();
  });

  test("false when Cloudflare rejects the token", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => ({
      json: async () => ({ success: false, "error-codes": ["invalid-input-response"] }),
    }));
    const ok = await verifyTurnstileToken("bad-token", { secretKey: "s" });
    assert.equal(ok, false);
    fetchMock.mock.restore();
  });

  test("false, not a throw, when Cloudflare is unreachable", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => {
      throw new Error("network down");
    });
    const ok = await verifyTurnstileToken("some-token", { secretKey: "s" });
    assert.equal(ok, false);
    fetchMock.mock.restore();
  });
});
