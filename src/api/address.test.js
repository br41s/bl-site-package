import { test, describe, before, beforeEach, after, mock } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

// Same local-fake pattern as monei.test.js: the router reads ADDRESS_API_URL on
// every request, so the test points it at a stand-in instead of cartociudad.es.
const express = (await import("express")).default;
const addressRouter = (await import("./address.js")).default;

let server;
let baseUrl;
let fakeUpstream;
let hits;
let requests;
let answer;

before(async () => {
  // A stand-in for cartociudad.es: records the request and answers as told.
  fakeUpstream = createServer((req, res) => {
    hits += 1;
    requests.push({ url: req.url, headers: req.headers });
    res.writeHead(answer.status, { "Content-Type": "application/json" });
    res.end(answer.body);
  });
  await new Promise((resolve) => fakeUpstream.listen(0, resolve));
  process.env.ADDRESS_API_URL = `http://127.0.0.1:${fakeUpstream.address().port}/geocoder/api/geocoder/candidates`;

  const app = express();
  app.use("/api/address", addressRouter);
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  mock.restoreAll();
  server?.close();
  fakeUpstream?.close();
});

const CANDIDATES = [
  // Not a delivery address: dropped.
  { type: "municipio", address: "Madrid", postalCode: "28014", poblacion: "Madrid" },
  { type: "portal", address: "CALLE ALCALA 50, Madrid", postalCode: "28014", poblacion: "Madrid" },
  { type: "callejero", address: "CALLE MAYOR, Madrid", postalCode: null, poblacion: "Madrid" },
  { type: "portal", address: "CALLE ALCALA 52, Madrid", postalCode: "28014", poblacion: "Madrid" },
  { type: "portal", address: "CALLE ALCALA 54, Madrid", postalCode: "28014", poblacion: "Madrid" },
  { type: "portal", address: "CALLE ALCALA 56, Madrid", postalCode: null, poblacion: "Madrid" },
  { type: "portal", address: "CALLE ALCALA 58, Madrid", postalCode: "28014", poblacion: "Madrid" },
  // Kept types past the sixth: cut.
  { type: "portal", address: "CALLE ALCALA 60, Madrid", postalCode: "28014", poblacion: "Madrid" },
  { type: "portal", address: "CALLE ALCALA 62, Madrid", postalCode: "28014", poblacion: "Madrid" },
  // No address to build a suggestion from.
  { type: "portal", address: 42, postalCode: "28014", poblacion: "Madrid" },
];

const goodAnswer = () => ({ status: 200, body: JSON.stringify(CANDIDATES) });

beforeEach(() => {
  hits = 0;
  requests = [];
  answer = goodAnswer();
});

const suggest = (q) =>
  fetch(`${baseUrl}/api/address/suggest?q=${encodeURIComponent(q)}`).then(async (res) => ({
    status: res.status,
    body: await res.json(),
  }));

describe("GET /api/address/suggest", () => {
  test("maps portal and callejero, drops the other types, strips the town and caps at 6", async () => {
    const { status, body } = await suggest("  Calle   Alcalá   50  ");
    assert.equal(status, 200);

    // The query reaches the geocoder trimmed, whitespace collapsed and encoded.
    assert.equal(hits, 1);
    assert.match(requests[0].url, /q=Calle%20Alcal%C3%A1%2050/);
    assert.match(requests[0].url, /limit=10/);
    assert.match(requests[0].url, /no_process=municipio,provincia,comunidad_autonoma/);

    assert.equal(body.suggestions.length, 6);
    assert.deepEqual(body.suggestions[0], {
      label: "CALLE ALCALA 50, Madrid (28014)",
      street: "CALLE ALCALA 50",
      postal_code: "28014",
      city: "Madrid",
    });
    // A null postal code upstream is an empty string here, and no "()" in the label.
    assert.deepEqual(body.suggestions[1], {
      label: "CALLE MAYOR, Madrid",
      street: "CALLE MAYOR",
      postal_code: "",
      city: "Madrid",
    });
    // Upstream order is preserved and the later ones are cut.
    assert.deepEqual(
      body.suggestions.map((s) => s.street),
      ["CALLE ALCALA 50", "CALLE MAYOR", "CALLE ALCALA 52", "CALLE ALCALA 54", "CALLE ALCALA 56", "CALLE ALCALA 58"],
    );
  });

  test("a query shorter than 3 or longer than 100 chars is answered empty without asking upstream", async () => {
    for (const q of ["", "a", "ca", "x".repeat(101)]) {
      const { status, body } = await suggest(q);
      assert.equal(status, 200, `query ${JSON.stringify(q)}`);
      assert.deepEqual(body, { suggestions: [] });
    }
    assert.equal(hits, 0);
  });

  test("an upstream 500 answers 200 with an empty list", async () => {
    answer = { status: 500, body: JSON.stringify({ error: "boom" }) };
    const { status, body } = await suggest("calle error servidor");
    assert.equal(status, 200);
    assert.deepEqual(body, { suggestions: [] });
  });

  test("invalid JSON answers 200 with an empty list", async () => {
    answer = { status: 200, body: "{not json" };
    const { status, body } = await suggest("calle json roto");
    assert.equal(status, 200);
    assert.deepEqual(body, { suggestions: [] });
  });

  test("the second identical query is served from cache and a different one asks upstream again", async () => {
    await suggest("calle cache uno");
    assert.equal(hits, 1);
    await suggest("CALLE CACHE UNO"); // same query, different case
    assert.equal(hits, 1);
    await suggest("calle cache dos");
    assert.equal(hits, 2);
  });

  test("a failure is not cached: the next attempt asks upstream again", async () => {
    answer = { status: 503, body: "[]" };
    await suggest("calle reintento");
    assert.equal(hits, 1);
    answer = goodAnswer();
    const { body } = await suggest("calle reintento");
    assert.equal(hits, 2);
    assert.equal(body.suggestions.length, 6);
  });

  test("the upstream gets no cookie or referer and a failure log never contains the typed text", async () => {
    answer = { status: 500, body: "[]" };
    const logged = [];
    mock.method(console, "error", (...args) => logged.push(args.join(" ")));
    const { body } = await suggest("calle privada del cliente");
    assert.deepEqual(body, { suggestions: [] });

    assert.equal(requests[0].headers.cookie, undefined);
    assert.equal(requests[0].headers.referer, undefined);
    assert.equal(requests[0].headers["user-agent"], "bl-site-package");

    assert.ok(logged.length > 0, "the reason is logged");
    assert.ok(logged.some((line) => /HTTP 500/.test(line)));
    for (const line of logged) assert.doesNotMatch(line, /privada/i);
  });
});
