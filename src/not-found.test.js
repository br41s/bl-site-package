import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { notFoundHandler } from "./not-found.js";

// A directory with, or without, a 404.html saying who it is.
function dir(page) {
  const d = mkdtempSync(join(tmpdir(), "bl-site-404-"));
  if (page) writeFileSync(join(d, "404.html"), `<!doctype html><p>${page}</p>`);
  return d;
}

const servers = [];
after(() => servers.forEach((s) => s.close()));

// The relevant slice of src/server.js: the explicit route for the page
// itself, the static mount of the built site, the catch-all.
async function serve({ siteDir, webDir }) {
  const app = express();
  const notFound = notFoundHandler({ siteDir, webDir });
  app.get(["/404", "/404.html"], notFound);
  app.use(express.static(siteDir, { extensions: ["html"] }));
  app.use(notFound);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  servers.push(server);
  return (path) => fetch(`http://127.0.0.1:${server.address().port}${path}`);
}

describe("the 404 page", () => {
  test("an unknown path gets the built page with a 404 status", async () => {
    const get = await serve({ siteDir: dir("BUILT"), webDir: dir("FALLBACK") });
    const res = await get("/no-existe");
    assert.equal(res.status, 404);
    assert.match(res.headers.get("content-type"), /text\/html/);
    assert.ok((await res.text()).includes("BUILT"));
  });

  test("the page's own URLs answer 404 too, not a 200 from the static mount", async () => {
    const get = await serve({ siteDir: dir("BUILT"), webDir: dir("FALLBACK") });
    for (const path of ["/404", "/404.html"]) {
      const res = await get(path);
      assert.equal(res.status, 404, path);
      assert.ok((await res.text()).includes("BUILT"), path);
    }
  });

  test("without a built page, the static fallback", async () => {
    const get = await serve({ siteDir: dir(null), webDir: dir("FALLBACK") });
    const res = await get("/no-existe");
    assert.equal(res.status, 404);
    assert.ok((await res.text()).includes("FALLBACK"));
  });

  test("without either, a JSON 404 rather than an empty reply", async () => {
    const get = await serve({ siteDir: dir(null), webDir: dir(null) });
    const res = await get("/no-existe");
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "Not found" });
  });
});
