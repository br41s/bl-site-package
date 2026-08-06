import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// database.js resolves DB_PATH at import time, so this has to be set before
// mailer.js (which imports it) is loaded.
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "bl-mailer-")), "app.db");

const db = (await import("../db/database.js")).default;
const {
  getMailSettings,
  isSmtpConfigured,
  isNotifyEmailConfigured,
  recordContactEmailResult,
  getLastContactEmail,
  _resetLastContactEmail,
} = await import("./mailer.js");

// Writing config directly instead of via setConfig(): setConfig triggers
// scheduleRebuild(), which would fire a real Eleventy build 400ms into the run.
function setRawConfig(key, value) {
  db.prepare(
    "INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)",
  ).run(key, value);
}

const SMTP_ENV = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "NOTIFY_EMAIL"];

beforeEach(() => {
  db.prepare("DELETE FROM config").run();
  for (const k of SMTP_ENV) delete process.env[k];
  _resetLastContactEmail();
});

after(() => db.close());

describe("mail settings resolution", () => {
  test("reads from panel config", () => {
    setRawConfig("smtp_host", "smtp.example.com");
    setRawConfig("smtp_user", "user@example.com");
    setRawConfig("smtp_pass", "secret");
    setRawConfig("smtp_port", "465");
    setRawConfig("notify_email", "owner@example.com");

    const s = getMailSettings();
    assert.equal(s.host, "smtp.example.com");
    assert.equal(s.port, 465);
    assert.equal(s.notifyEmail, "owner@example.com");
  });

  test("env var wins over panel config", () => {
    setRawConfig("smtp_host", "panel.example.com");
    process.env.SMTP_HOST = "env.example.com";
    assert.equal(getMailSettings().host, "env.example.com");
  });

  test("defaults to port 587 when unset", () => {
    assert.equal(getMailSettings().port, 587);
  });
});

describe("configuration booleans", () => {
  test("false on a fresh instance", () => {
    assert.equal(isSmtpConfigured(), false);
    assert.equal(isNotifyEmailConfigured(), false);
  });

  test("smtp needs host, user and pass together", () => {
    setRawConfig("smtp_host", "smtp.example.com");
    setRawConfig("smtp_user", "user@example.com");
    assert.equal(isSmtpConfigured(), false, "missing pass must not read as configured");
    setRawConfig("smtp_pass", "secret");
    assert.equal(isSmtpConfigured(), true);
  });

  test("notify email is independent of smtp", () => {
    setRawConfig("notify_email", "owner@example.com");
    assert.equal(isNotifyEmailConfigured(), true);
    assert.equal(isSmtpConfigured(), false);
  });
});

describe("last contact e-mail outcome", () => {
  test("null until an attempt happens", () => {
    assert.equal(getLastContactEmail(), null);
  });

  test("records success without an error class", () => {
    recordContactEmailResult(true);
    const last = getLastContactEmail();
    assert.equal(last.ok, true);
    assert.equal(last.error, null);
    assert.ok(!Number.isNaN(Date.parse(last.at)));
  });

  test("records the error code, never the message", () => {
    const err = new Error("535 auth failed for user@example.com");
    err.code = "EAUTH";
    recordContactEmailResult(false, err);

    const last = getLastContactEmail();
    assert.equal(last.ok, false);
    assert.equal(last.error, "EAUTH");
    assert.ok(
      !JSON.stringify(last).includes("user@example.com"),
      "the SMTP rejection string must not leak into the reported state",
    );
  });

  test("falls back to a placeholder when the error carries no code", () => {
    recordContactEmailResult(false, {});
    assert.equal(getLastContactEmail().error, "unknown");
  });
});
