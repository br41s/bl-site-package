// Slice 2 of the Cálida style (DESIGN.md §5.5, §5.8): the ### blocks of a page
// body as cards, the FAQ block as accordions with its FAQPage data, exercised
// through the Eleventy data file that shapes them (site/_data/site.js) and
// through a real build of the templates that render them. Clásico is built
// from the same content and must show none of it.
//
// This test lives in src/ and NOT next to the files it covers, deliberately —
// see the note at the top of src/build/product-content.test.js and the guard in
// src/build/no-tests-in-site.test.js.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Writing config would otherwise kick off a real Eleventy build per assertion.
process.env.BL_SITE_DISABLE_REBUILD = "1";
// database.js resolves DB_PATH at import time and refuses to start if it lands
// in a served directory, so point it at a throwaway dir before anything that
// imports it is loaded. The builds below inherit it.
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "bl-site-calida-")), "app.db");

const db = (await import("../db/database.js")).default;
const siteData = (await import("../../site/_data/site.js")).default;
const { formatContent } = await import("../content/format-content.js");

const root = join(import.meta.dirname, "../..");

const SERVICIOS = `Llevamos veinte años cuidando motos en Vigo.

### Revisión *completa*

Aceite, filtros, frenos y neumáticos en el día.

### Neumáticos

Montaje y equilibrado.

### Pintura

Colores de serie o a tu gusto.

### Transporte

Recogemos la moto en tu casa.

## Preguntas frecuentes

### ¿Hacéis presupuesto sin compromiso?

Sí, siempre antes de tocar la moto.

### ¿Cuánto tarda una revisión?

Normalmente la tienes el mismo día.`;

const QUIENES = `Un taller pequeño, de confianza.

### Ana García

<img src="/uploads/ana.webp" alt="Ana en el taller">

Mecánica jefe desde 2010.

### Luis Pérez

Chapa y pintura.`;

const FAQ_ONLY = `## Preguntas frecuentes

### ¿Abrís los sábados?

Sí, por la mañana.

### ¿Hay aparcamiento?

Delante del taller.`;

function seed(style) {
  db.prepare("DELETE FROM config").run();
  const put = db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)");
  for (const [k, v] of Object.entries({
    site_style: style,
    company_name: "Taller Prueba",
    site_url: "https://taller.example",
    page_index_title: "Tu moto, *a punto*",
    page_index_body: FAQ_ONLY,
    page_servicios_title: "Servicios",
    page_servicios_subtitle: "Todo lo que tu moto necesita",
    page_servicios_desc: SERVICIOS,
    page_quienes_title: "Quiénes somos",
    page_quienes_desc: QUIENES,
    page_contacto_title: "Contacto",
    page_contacto_desc: FAQ_ONLY,
  })) put.run(k, v);
}

// One real Eleventy build into a throwaway directory — the same child process
// src/build/rebuild.js spawns, so the templates are rendered exactly as in
// production, without touching the repo's _site.
function build() {
  const out = mkdtempSync(join(tmpdir(), "bl-site-calida-out-"));
  const r = spawnSync(process.execPath, [join(root, "src/build/eleventy-child.js"), out], {
    cwd: root,
    env: { ...process.env },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `build failed:\n${r.stderr}\n${r.stdout}`);
  return (file) => readFileSync(join(out, file), "utf8");
}

const count = (html, re) => [...html.matchAll(re)].length;
const faqLd = (html) => count(html, /"@type":"FAQPage"/g);

describe("site data (site/_data/site.js)", () => {
  test("in Cálida, the ### blocks become cards and the FAQ block carries its data", () => {
    seed("calida");
    const site = siteData();
    assert.equal(site.calida, true);
    assert.deepEqual(
      site.page_servicios_cards.cards.map((c) => c.plainTitle),
      ["Revisión completa", "Neumáticos", "Pintura", "Transporte"],
    );
    assert.equal(site.page_quienes_cards.cards.length, 2);
    assert.deepEqual(site.page_quienes_cards.cards[0].image, { src: "/uploads/ana.webp", alt: "Ana en el taller" });
    assert.ok(site.page_servicios_desc_html.includes('<details class="c-faq">'));
    assert.equal(site.page_faq_ld.servicios.mainEntity.length, 2);
    assert.equal(site.page_faq_ld.index.mainEntity.length, 2);
    assert.equal(site.page_faq_ld.contacto.mainEntity.length, 2);
    assert.equal(site.page_faq_ld.quienes, null);
  });

  test("in Clásico, the rendered bodies are formatContent's output and nothing else is added", () => {
    seed("");
    const site = siteData();
    assert.equal(site.calida, false);
    assert.equal(site.page_servicios_desc_html, formatContent(SERVICIOS));
    assert.equal(site.page_quienes_desc_html, formatContent(QUIENES));
    assert.equal(site.page_contacto_desc_html, formatContent(FAQ_ONLY));
    assert.equal(site.page_servicios_cards, undefined);
    assert.equal(site.page_quienes_cards, undefined);
    assert.equal(site.page_faq_ld, undefined);
  });
});

describe("Cálida build", () => {
  let read;
  before(() => {
    seed("calida");
    read = build();
  });

  test("/servicios: intro prose, a grid of cards, then the FAQ as accordions with FAQPage data", () => {
    const html = read("servicios.html");
    assert.equal(count(html, /<article class="c-card">/g), 4);
    assert.ok(html.indexOf("veinte años") < html.indexOf('<div class="c-card-grid'), "intro comes first");
    assert.ok(html.includes('<span class="c-icon-circle c-card-mark" aria-hidden="true">4</span>'), html);
    assert.ok(html.includes("<h3>Revisión <em>completa</em></h3>"), html);
    assert.equal(count(html, /<details class="c-faq">/g), 2);
    assert.ok(html.indexOf('<div class="c-card-grid') < html.indexOf("<h2>Preguntas frecuentes</h2>"), "the FAQ comes after the cards");
    assert.equal(faqLd(html), 1);
  });

  test("/quienes-somos: team cards, the block's image as media, an initial when there is none", () => {
    const html = read("quienes-somos.html");
    assert.equal(count(html, /<article class="c-card">/g), 2);
    assert.ok(html.includes('<img src="/uploads/ana.webp" alt="Ana en el taller" class="c-card-media"'), html);
    assert.ok(html.includes('<span class="c-icon-circle c-card-mark" aria-hidden="true">L</span>'), html);
    assert.equal(faqLd(html), 0, "no FAQ block on this page, no FAQPage");
  });

  test("home: the first three cards replace the services band, with a link to all of them", () => {
    const html = read("index.html");
    assert.equal(count(html, /<article class="c-card">/g), 3);
    assert.ok(html.includes("Ver todos los servicios"), html);
    assert.ok(!html.includes('class="c-band'), "the band fallback is not rendered when there are cards");
    // The home body's own FAQ block.
    assert.equal(count(html, /<details class="c-faq">/g), 2);
    assert.equal(faqLd(html), 1);
  });

  test("/contacto: the intro's FAQ block as accordions with its data", () => {
    const html = read("contacto.html");
    assert.equal(count(html, /<details class="c-faq">/g), 2);
    assert.equal(faqLd(html), 1);
  });

  test("a Servicios body without ### keeps the band on the home and the plain body on /servicios", () => {
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('page_servicios_desc', 'Solo un párrafo.')").run();
    const readPlain = build();
    assert.ok(readPlain("index.html").includes('class="c-band reveal"'));
    assert.ok(!readPlain("index.html").includes("c-card"));
    assert.ok(readPlain("servicios.html").includes('<div class="site-page-body reveal"><p>Solo un párrafo.</p>\n</div>'));
  });
});

describe("Clásico build of the same content", () => {
  let read;
  before(() => {
    seed("");
    read = build();
  });

  test("renders the bodies as formatContent leaves them: no cards, no accordions, no FAQPage", () => {
    for (const [file, md] of [["servicios.html", SERVICIOS], ["quienes-somos.html", QUIENES], ["contacto.html", FAQ_ONLY]]) {
      const html = read(file);
      assert.ok(html.includes(`<div class="site-page-body reveal">${formatContent(md)}</div>`), file);
      assert.ok(!html.includes("c-card") && !html.includes("<details") && !html.includes("c-faq"), file);
      assert.equal(faqLd(html), 0, file);
    }
    const home = read("index.html");
    assert.ok(!home.includes("c-card") && !home.includes("<details"), "home");
    assert.equal(faqLd(home), 0, "home");
  });

});
