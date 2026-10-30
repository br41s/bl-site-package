import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { cleanUrlHandler } from "./clean-urls.js";

const BUILT = new Set(["//productos/x.html", "/\\productos/x.html", "/productos/x.html", "/servicios.html", "/productos/index.html", "/404.html"]);
const servers = [];
after(() => servers.forEach((s) => s.close()));

async function serve() {
  const app = express();
  app.use(cleanUrlHandler({ exists: (p) => BUILT.has(p) }));
  app.use((req, res) => res.status(200).send("served"));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  servers.push(server);
  return (path, init) =>
    fetch(`http://127.0.0.1:${server.address().port}${path}`, { redirect: "manual", ...init });
}

describe("clean URLs", () => {
  test("a built page's .html twin 301s to the clean address", async () => {
    const get = await serve();
    for (const [from, to] of [
      ["/productos/x.html", "/productos/x"],
      ["/servicios.html", "/servicios"],
      ["/productos/index.html", "/productos/"],
      ["/productos/x.html?utm=1", "/productos/x?utm=1"],
    ]) {
      const res = await get(from);
      assert.equal(res.status, 301, from);
      assert.equal(res.headers.get("location"), to, from);
    }
  });

  test("the clean address, the 404 page, unbuilt files and non-GET are left alone", async () => {
    const get = await serve();
    for (const path of ["/productos/x", "/404.html", "/panel.html", "/uploads/a.html", "//productos/x.html", "/\\productos/x.html"]) {
      assert.equal((await get(path)).status, 200, path);
    }
    assert.equal((await get("/productos/x.html", { method: "POST" })).status, 200);
  });
});
