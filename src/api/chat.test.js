import { test, describe, before, beforeEach, after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// database.js resolves DB_PATH at import time, so point it at a throwaway dir
// before anything that imports it is loaded.
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "bl-site-chat-")), "app.db");
process.env.JWT_SECRET = "test-secret-for-chat";

const express = (await import("express")).default;
const jwt = (await import("jsonwebtoken")).default;
const db = (await import("../db/database.js")).default;
const chatRouter = (await import("./chat.js")).default;

const TOKEN = jwt.sign({ role: "admin" }, process.env.JWT_SECRET);

// Direct write, not setConfig(): setConfig calls scheduleRebuild(), which
// would kick off a real Eleventy build in the middle of the test run.
function setRawConfig(key, value) {
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(
    key,
    value,
  );
}

let server;
let baseUrl;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/chat", chatRouter);
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
  db.prepare("DELETE FROM chat_history").run();
  setRawConfig("openrouter_api_key", "test-key");
});

function send(message = "Escribe un artículo") {
  return fetch(baseUrl + "/api/chat/send", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-panel-token": TOKEN },
    body: JSON.stringify({ message }),
  });
}

// Stub only OpenRouter; the test's own call to the local server has to go
// through the real fetch.
function stubOpenRouter(handler) {
  const realFetch = globalThis.fetch;
  const calls = [];
  const fetchMock = mock.method(globalThis, "fetch", async (url, opts) => {
    if (typeof url === "string" && url.includes("openrouter.ai")) {
      calls.push({ url, opts });
      return handler(calls.length, opts);
    }
    return realFetch(url, opts);
  });
  return { calls, restore: () => fetchMock.mock.restore() };
}

function timeoutError() {
  return new DOMException("The operation timed out", "TimeoutError");
}

function completion(content) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ choices: [{ message: { content } }] }),
  };
}

describe("POST /api/chat/send — upstream deadlines", () => {
  test("every attempt carries an abort signal, so nothing waits forever", async () => {
    const stub = stubOpenRouter(() => completion("Hola"));

    const res = await send();
    assert.equal(res.status, 200);
    assert.equal(stub.calls.length, 1);
    assert.ok(stub.calls[0].opts.signal instanceof AbortSignal);

    stub.restore();
  });

  test("answers 504 instead of hanging when the model never responds", async () => {
    const stub = stubOpenRouter(() => {
      throw timeoutError();
    });

    const res = await send();
    const body = await res.json();

    assert.equal(res.status, 504);
    assert.equal(body.error, "timeout");
    // The panel only renders `reply`, so a bare error code would show the
    // client "Sin respuesta".
    assert.ok(body.reply.length > 0);

    stub.restore();
  });

  test("a wedged model doesn't lose the run — the next one still answers", async () => {
    const stub = stubOpenRouter((call) => {
      if (call === 1) throw timeoutError();
      return completion("Aquí tienes el artículo");
    });

    const res = await send();
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.reply, "Aquí tienes el artículo");
    assert.equal(stub.calls.length, 2);
    // It fell back to a different model rather than retrying the wedged one.
    assert.notEqual(
      JSON.parse(stub.calls[1].opts.body).model,
      JSON.parse(stub.calls[0].opts.body).model,
    );

    stub.restore();
  });

  test("a failure that isn't a timeout is still a 500, not a 504", async () => {
    const stub = stubOpenRouter(() => {
      throw new TypeError("fetch failed");
    });

    const res = await send();
    assert.equal(res.status, 500);

    stub.restore();
  });
});

describe("POST /api/chat/send — which model is asked first", () => {
  test("with no model configured it asks for the paid gpt-oss-120b", async () => {
    const stub = stubOpenRouter(() => completion("Hola"));

    const res = await send();
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(stub.calls[0].opts.body).model, "openai/gpt-oss-120b");

    stub.restore();
  });

  test("a model the customer saved wins, including a free one", async () => {
    setRawConfig("ai_model", "openai/gpt-oss-20b:free");
    const stub = stubOpenRouter(() => completion("Hola"));

    const res = await send();
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(stub.calls[0].opts.body).model, "openai/gpt-oss-20b:free");

    stub.restore();
  });

  test("a key with no credit (402 on the paid default) still gets an answer from a free model", async () => {
    const stub = stubOpenRouter((call) => {
      if (call === 1) {
        return { ok: false, status: 402, text: async () => '{"error":{"message":"Insufficient credits"}}' };
      }
      return completion("Aquí tienes");
    });

    const res = await send();
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(stub.calls[0].opts.body).model, "openai/gpt-oss-120b");
    assert.match(JSON.parse(stub.calls[1].opts.body).model, /:free$/);

    stub.restore();
  });

  test("any other upstream error is still a 502 and does not burn through every model", async () => {
    const stub = stubOpenRouter(() => ({ ok: false, status: 500, text: async () => "{}" }));

    const res = await send();
    assert.equal(res.status, 502);
    assert.equal(stub.calls.length, 1);

    stub.restore();
  });
});
