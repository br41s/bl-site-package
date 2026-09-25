import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import express from "express";
import { asyncHandler, apiErrorHandler } from "./async-handler.js";

let server;
let baseUrl;
const logged = [];

before(async () => {
  const app = express();
  app.use(express.json());
  app.post(
    "/boom",
    asyncHandler(async () => {
      throw new Error("SQLITE_CONSTRAINT: NOT NULL constraint failed: reservations.total_cents");
    }),
  );
  app.get(
    "/later",
    asyncHandler(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      throw new Error("rejected after an await");
    }),
  );
  app.get("/ok", asyncHandler(async (req, res) => res.json({ ok: true })));
  app.get("/sync", () => {
    throw new Error("sync throw");
  });
  app.use((err, req, res, next) => {
    logged.push(err.message);
    next(err);
  });
  app.use(apiErrorHandler);
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

describe("asyncHandler + apiErrorHandler", () => {
  // Without the wrapper this request never answers and, outside the test
  // runner, Node 22 exits the process on the unhandled rejection.
  test("a throwing async route answers 500 JSON instead of killing the server", async () => {
    const res = await fetch(`${baseUrl}/boom`, { method: "POST" });
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: "Error interno del servidor" });
    // Still serving afterwards.
    assert.equal((await fetch(`${baseUrl}/ok`)).status, 200);
  });

  test("a rejection after an await is caught too", async () => {
    const res = await fetch(`${baseUrl}/later`);
    assert.equal(res.status, 500);
  });

  test("the internal message never reaches the client", async () => {
    const body = await (await fetch(`${baseUrl}/boom`, { method: "POST" })).text();
    assert.ok(!body.includes("SQLITE"), body);
    assert.ok(logged.some((m) => m.includes("SQLITE_CONSTRAINT")));
  });

  test("a sync throw gets the same JSON answer", async () => {
    const res = await fetch(`${baseUrl}/sync`);
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: "Error interno del servidor" });
  });

  test("a malformed JSON body keeps its 400", async () => {
    const res = await fetch(`${baseUrl}/boom`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "Petición no válida" });
  });
});

describe("every async route is wrapped", () => {
  // The wrapper only protects the routes it is applied to, and forgetting it
  // is silent until the day that route throws in production. This reads the
  // source instead: an anonymous `async (req` handler must sit directly
  // inside asyncHandler(. It does not see a route that calls a named async
  // function — wrap those by hand (see the setStatus routes in
  // src/api/conversations.js).
  const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

  function sources(dir) {
    const found = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) found.push(...sources(path));
      else if (entry.name.endsWith(".js") && !entry.name.endsWith(".test.js")) found.push(path);
    }
    return found;
  }

  test("no unwrapped `async (req` handler under src/", () => {
    const offenders = [];
    for (const file of sources(join(root, "src"))) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/async\s*(?:function\s*)?\(\s*req\b/g)) {
        const before = text.slice(Math.max(0, match.index - 20), match.index);
        if (!/asyncHandler\(\s*$/.test(before)) {
          const line = text.slice(0, match.index).split("\n").length;
          offenders.push(`${relative(root, file)}:${line}`);
        }
      }
    }
    assert.deepEqual(offenders, [], "wrap these in asyncHandler(...)");
  });
});
