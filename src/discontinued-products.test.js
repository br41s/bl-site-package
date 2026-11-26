import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { discontinuedProductHandler } from "./discontinued-products.js";

const CATEGORIES = new Map([
  ["123-bolsa", "Plastificadoras"],
  ["124-sin-categoria", ""],
  ["125-otra", "Otra"],
]);
const BUILT = new Set(["plastificadoras"]);

const servers = [];
after(() => servers.forEach((s) => s.close()));

// The relevant slice of src/server.js: the handler, then the catch-all.
async function serve() {
  const app = express();
  app.use(
    discontinuedProductHandler({
      findCategory: (slug) => CATEGORIES.get(slug),
      categoryBuilt: (slug) => BUILT.has(slug),
    }),
  );
  app.use((req, res) => res.status(404).end());
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  servers.push(server);
  return (path, init) =>
    fetch(`http://127.0.0.1:${server.address().port}${path}`, { redirect: "manual", ...init });
}

async function expectRedirect(get, path, target) {
  const res = await get(path);
  assert.equal(res.status, 302, path);
  assert.equal(res.headers.get("location"), target, path);
}

describe("discontinued product pages", () => {
  test("a product that is no longer built goes to its category page", async () => {
    const get = await serve();
    await expectRedirect(get, "/productos/123-bolsa", "/productos/categoria/plastificadoras/");
    await expectRedirect(get, "/productos/123-bolsa.html", "/productos/categoria/plastificadoras/");
  });

  test("an unbuilt category falls back to the shop", async () => {
    const get = await serve();
    await expectRedirect(get, "/productos/125-otra", "/productos/");
  });

  test("a product with no category goes to the shop", async () => {
    const get = await serve();
    await expectRedirect(get, "/productos/124-sin-categoria", "/productos/");
  });

  test("an unknown product stays a 404", async () => {
    const get = await serve();
    assert.equal((await get("/productos/999-nada")).status, 404);
  });

  test("non-product paths and non-GET requests are left alone", async () => {
    const get = await serve();
    const paths = [
      "/productos/",
      "/productos/2",
      "/productos/categoria/plastificadoras/",
      "/productos/marca/x/",
      "/servicios",
    ];
    for (const path of paths) assert.equal((await get(path)).status, 404, path);
    assert.equal((await get("/productos/123-bolsa", { method: "POST" })).status, 404);
  });

  test("the query string is dropped", async () => {
    const get = await serve();
    await expectRedirect(get, "/productos/123-bolsa?utm=1", "/productos/categoria/plastificadoras/");
  });
});
