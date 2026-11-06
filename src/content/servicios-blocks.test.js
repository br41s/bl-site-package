import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ICON_NAMES, parseServiciosBlocks, isValidServiciosBlocks, anchorSections } from "./servicios-blocks.js";
import { formatContent } from "./format-content.js";

const AI = { title: "IA", intro: "x", url: "https://example.com/a", label: "Ver", cards: [{ icon: "chat", title: "T", text: "t" }] };

describe("servicios blocks", () => {
  test("every listed icon is drawn by icon.njk", () => {
    const njk = readFileSync(new URL("../../site/_includes/icon.njk", import.meta.url), "utf8");
    for (const n of ICON_NAMES) assert.ok(njk.includes(`icon == "${n}"`), n);
  });

  test("strict validation", () => {
    assert.ok(isValidServiciosBlocks(""));
    assert.ok(isValidServiciosBlocks(JSON.stringify({ overview: ["printer"], ai: AI })));
    for (const bad of [
      "not json", "[]", "{}", JSON.stringify({ overview: ["nope"] }),
      JSON.stringify({ ai: { ...AI, url: "http://example.com" } }),
      JSON.stringify({ ai: { ...AI, url: "javascript:alert(1)" } }),
      JSON.stringify({ ai: { ...AI, url: "https://u:p@example.com" } }),
      JSON.stringify({ ai: { ...AI, cards: [] } }),
      JSON.stringify({ ai: { ...AI, cards: [{ icon: "x", title: "T", text: "t" }] } }),
    ]) assert.equal(isValidServiciosBlocks(bad), false, bad);
  });

  test("lenient parse drops bad pieces and never throws", () => {
    assert.equal(parseServiciosBlocks("garbage"), null);
    assert.equal(parseServiciosBlocks(""), null);
    const p = parseServiciosBlocks({ ai: { ...AI, url: "ftp://x" } });
    assert.equal(p, null);
    assert.equal(parseServiciosBlocks({ overview: ["zzz"] }).overview[0], "sparkle");
  });

  test("anchors: ids on h2, first paragraph as text, duplicates disambiguated", () => {
    const html = formatContent("Intro\n\n## Impresión digital\n\nSoluciones de impresión.\n\n- a\n\n## Impresión digital\n\nOtra.");
    const { html: out, items } = anchorSections(html, ["printer"]);
    assert.deepEqual(items.map((i) => i.id), ["impresion-digital", "impresion-digital-2"]);
    assert.equal(items[0].icon, "printer");
    assert.equal(items[1].icon, "sparkle");
    assert.equal(items[0].text, "Soluciones de impresión.");
    assert.match(out, /<h2 id="impresion-digital">/);
    assert.match(out, /<li>a<\/li>/);
  });
});
