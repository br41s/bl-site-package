import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { legacyUrlHandler } from "./legacy-urls.js";

const SOLD = new Map([
  ["172667", "172667-bloc-musica-y-canto"],
  ["92382", "92382-boligrafo-bic-cristal"],
]);
const CATEGORIES = new Set(["plastificadoras"]);

const servers = [];
after(() => servers.forEach((s) => s.close()));

// The relevant slice of src/server.js: the handler, then the catch-all.
async function serve() {
  const app = express();
  app.use(
    legacyUrlHandler({
      findSoldSlug: (sku) => SOLD.get(sku),
      categoryExists: (slug) => CATEGORIES.has(slug),
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
  assert.equal(res.status, 301, path);
  assert.equal(res.headers.get("location"), target, path);
}

describe("legacy shop URLs", () => {
  test("a product page goes to the product by its feed id", async () => {
    const get = await serve();
    await expectRedirect(
      get,
      "/product/172667-bloc-musica-y-canto-liderpapel-pentagrama-din-a4-24-hojas-100gm2.html",
      "/productos/172667-bloc-musica-y-canto",
    );
  });

  test("session-id product URLs go to the product named by codProduct", async () => {
    const get = await serve();
    const q = "?s=7766&o=product_b2c&p=1&codProduct=92382&descProduct=boligrafo-bic";
    for (const prefix of ["/product/PStores", "/searchcat/PStores;jsessionid=7C3E4A73B5479C4D13844D09484DFBDA"]) {
      await expectRedirect(get, prefix + q, "/productos/92382-boligrafo-bic-cristal");
    }
  });

  test("a product we no longer sell goes to the shop, not a 404", async () => {
    const get = await serve();
    await expectRedirect(get, "/product/1-descatalogado.html", "/productos/");
    await expectRedirect(get, "/searchcat/PStores?codProduct=999", "/productos/");
  });

  test("a category goes to ours when it is built, else to the shop", async () => {
    const get = await serve();
    await expectRedirect(get, "/cat/20-plastificadoras.html", "/productos/categoria/plastificadoras/");
    await expectRedirect(get, "/searchcat/12-calculadoras-de-bolsillo.html", "/productos/");
    await expectRedirect(get, "/searchcat/231-cartulinas.html_?codCategory=231&p=1", "/productos/");
    await expectRedirect(get, "/searchcat/164-164.html", "/productos/");
    await expectRedirect(get, "/searchcat/79-.html", "/productos/");
  });

  test("filtered listings of the old shop go to the shop", async () => {
    const get = await serve();
    await expectRedirect(get, "/PStores?searchString&codCategory=199&elementByPage=48", "/productos/");
    await expectRedirect(get, "/PStores;jsessionid=1C66F64A7F4129C9A217BE2CADAA3239?codCategory=199", "/productos/");
    await expectRedirect(get, "/searchcat/PStores?searchString&codCategory=29", "/productos/");
  });

  test("this site's own URLs and non-GET requests are left alone", async () => {
    const get = await serve();
    for (const path of ["/productos/", "/productos/172667-bloc-musica-y-canto.html", "/producto", "/servicios"]) {
      assert.equal((await get(path)).status, 404, path);
    }
    assert.equal((await get("/product/172667-x.html", { method: "POST" })).status, 404);
  });
});
