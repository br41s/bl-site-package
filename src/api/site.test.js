import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// database.js resolves DB_PATH at import time and refuses to start if it lands
// in a served directory, so point it at a throwaway dir before anything that
// imports it is loaded.
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "bl-site-api-")), "app.db");
process.env.JWT_SECRET = "test-secret-for-site-status";

const express = (await import("express")).default;
const jwt = (await import("jsonwebtoken")).default;
const db = (await import("../db/database.js")).default;
const siteRouter = (await import("./site.js")).default;
const { _resetLastContactEmail, recordContactEmailResult } = await import(
  "../mail/mailer.js"
);

const TOKEN = jwt.sign({ role: "admin" }, process.env.JWT_SECRET);

// Direct writes, not setConfig(): setConfig calls scheduleRebuild(), which
// would kick off a real Eleventy build in the middle of the test run.
function setRawConfig(key, value) {
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(
    key,
    value,
  );
}

function configureSmtp() {
  setRawConfig("smtp_host", "smtp.example.com");
  setRawConfig("smtp_user", "user@example.com");
  setRawConfig("smtp_pass", "secret");
  setRawConfig("notify_email", "owner@example.com");
}

let server;
let baseUrl;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/site", siteRouter);
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
  db.prepare("DELETE FROM articles").run();
  _resetLastContactEmail();
});

function call(method, path, { token, body } = {}) {
  return fetch(baseUrl + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("GET /api/site/status", () => {
  test("rejects an unauthenticated caller", async () => {
    const res = await call("GET", "/api/site/status");
    assert.equal(res.status, 401);
  });

  test("rejects an invalid token", async () => {
    const res = await call("GET", "/api/site/status", { token: "not-a-jwt" });
    assert.equal(res.status, 401);
  });

  test("reports the package version and the full documented shape", async () => {
    const res = await call("GET", "/api/site/status", { token: TOKEN });
    assert.equal(res.status, 200);
    const body = await res.json();

    const pkg = JSON.parse(
      await (await import("node:fs/promises")).readFile(
        new URL("../../package.json", import.meta.url),
        "utf8",
      ),
    );
    assert.equal(body.version, pkg.version);
    assert.deepEqual(Object.keys(body).sort(), [
      "built_at",
      "last_build_ok",
      "last_contact_email",
      "notify_email_configured",
      "posts",
      "smtp_configured",
      "version",
    ]);
  });

  test("mail booleans are false on an unconfigured instance", async () => {
    const body = await (await call("GET", "/api/site/status", { token: TOKEN })).json();
    assert.equal(body.smtp_configured, false);
    assert.equal(body.notify_email_configured, false);
  });

  test("mail booleans flip once configured, without leaking the values", async () => {
    configureSmtp();
    const res = await call("GET", "/api/site/status", { token: TOKEN });
    const raw = await res.text();

    assert.deepEqual(JSON.parse(raw).smtp_configured, true);
    assert.deepEqual(JSON.parse(raw).notify_email_configured, true);
    // The credentials and the recipient are in the same table as the panel
    // password; this endpoint must report presence and nothing else.
    for (const secret of [
      "smtp.example.com",
      "user@example.com",
      "secret",
      "owner@example.com",
    ]) {
      assert.ok(!raw.includes(secret), `status leaked ${secret}`);
    }
  });

  test("counts posts by status", async () => {
    const insert = db.prepare(
      "INSERT INTO articles (title, slug, content, status) VALUES (?, ?, ?, ?)",
    );
    insert.run("A", "a", "x", "published");
    insert.run("B", "b", "x", "published");
    insert.run("C", "c", "x", "draft");

    const body = await (await call("GET", "/api/site/status", { token: TOKEN })).json();
    assert.deepEqual(body.posts, { published: 2, draft: 1 });
  });

  test("post counts are zero, not undefined, on an empty blog", async () => {
    const body = await (await call("GET", "/api/site/status", { token: TOKEN })).json();
    assert.deepEqual(body.posts, { published: 0, draft: 0 });
  });

  test("surfaces the last contact-form e-mail outcome as class-only", async () => {
    const err = new Error("535 auth failed for user@example.com");
    err.code = "EAUTH";
    recordContactEmailResult(false, err);

    const res = await call("GET", "/api/site/status", { token: TOKEN });
    const raw = await res.text();
    assert.equal(JSON.parse(raw).last_contact_email.ok, false);
    assert.equal(JSON.parse(raw).last_contact_email.error, "EAUTH");
    assert.ok(!raw.includes("535 auth failed"));
  });
});

describe("POST /api/site/notify", () => {
  test("rejects an unauthenticated caller", async () => {
    const res = await call("POST", "/api/site/notify", {
      body: { subject: "s", body_markdown: "b" },
    });
    assert.equal(res.status, 401);
  });

  test("requires subject and body_markdown", async () => {
    for (const body of [{}, { subject: "s" }, { body_markdown: "b" }, { subject: " ", body_markdown: "b" }]) {
      const res = await call("POST", "/api/site/notify", { token: TOKEN, body });
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
      assert.equal((await res.json()).error, "invalid_body");
    }
  });

  test("rejects an oversized subject", async () => {
    const res = await call("POST", "/api/site/notify", {
      token: TOKEN,
      body: { subject: "x".repeat(201), body_markdown: "b" },
    });
    assert.equal(res.status, 400);
  });

  test("answers smtp_not_configured when the instance cannot send", async () => {
    const res = await call("POST", "/api/site/notify", {
      token: TOKEN,
      body: { subject: "Informe mensual", body_markdown: "# Todo bien" },
    });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, "smtp_not_configured");
  });

  test("notify_email alone is not enough to attempt a send", async () => {
    setRawConfig("notify_email", "owner@example.com");
    const res = await call("POST", "/api/site/notify", {
      token: TOKEN,
      body: { subject: "s", body_markdown: "b" },
    });
    assert.equal(res.status, 503);
  });
});

describe("POST /api/site/texts — appearance fields", () => {
  test("rejects an accent_color that isn't a 6-digit hex", async () => {
    for (const bad of ["red", "#fff", "#12345g", "javascript:alert(1)", "#fff}</style><script>x"]) {
      const res = await call("POST", "/api/site/texts", {
        token: TOKEN,
        body: { accent_color: bad },
      });
      assert.equal(res.status, 400, `expected 400 for ${bad}`);
    }
  });

  test("accepts a valid hex accent_color", async () => {
    const res = await call("POST", "/api/site/texts", {
      token: TOKEN,
      body: { accent_color: "#2563eb" },
    });
    assert.equal(res.status, 200);
  });

  test("rejects values outside the fixed option sets", async () => {
    const cases = [
      { radius_style: "circle" },
      { theme_default: "system" },
      { hero_density: "huge" },
    ];
    for (const body of cases) {
      const res = await call("POST", "/api/site/texts", { token: TOKEN, body });
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    }
  });

  test("accepts each option's allowed values, including empty string to reset", async () => {
    const cases = [
      { radius_style: "sharp" },
      { radius_style: "rounded" },
      { radius_style: "" },
      { theme_default: "dark" },
      { hero_density: "compact" },
    ];
    for (const body of cases) {
      const res = await call("POST", "/api/site/texts", { token: TOKEN, body });
      assert.equal(res.status, 200, `expected 200 for ${JSON.stringify(body)}`);
    }
  });
});

// Runs last on purpose: the limiter's bucket is process-wide and keyed by
// route + IP, so exhausting it would 429 every later /notify test.
describe("POST /api/site/notify — rate limit", () => {
  test("caps a burst from one caller", async () => {
    let last;
    for (let i = 0; i < 12; i++) {
      last = await call("POST", "/api/site/notify", {
        token: TOKEN,
        body: { subject: "s", body_markdown: "b" },
      });
      await last.text();
    }
    assert.equal(last.status, 429);
  });
});
