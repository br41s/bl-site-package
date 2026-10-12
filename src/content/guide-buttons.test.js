import { test } from "node:test";
import assert from "node:assert/strict";
import { renderCatalogueLinks } from "./guide-buttons.js";
import { formatContent } from "./format-content.js";

const lookup = new Map([
  ["1-in-stock", { priceDisplay: "69,95 €", inStock: true, available: true, categoryUrl: "/productos/categoria/plastificadoras/" }],
  ["2-out-of-stock", { priceDisplay: "40,00 €", inStock: false, available: true, categoryUrl: "/productos/categoria/plastificadoras/" }],
  ["3-retired", { priceDisplay: "10,00 €", inStock: true, available: false, categoryUrl: "/productos/categoria/pizarras/" }],
  ["4-no-category", { priceDisplay: "5,00 €", inStock: false, available: false, categoryUrl: null }],
]);

// What the agent writes goes through the sanitizer first, exactly as in the build.
const render = (md) => renderCatalogueLinks(formatContent(md), lookup);
const buy = (slug) => `<a href="/productos/${slug}" class="guide-buy">Ver precio y comprar</a>`;

test("an in-stock product's button shows the current price", () => {
  const out = render(buy("1-in-stock"));
  assert.ok(out.includes('<a href="/productos/1-in-stock" class="site-btn guide-buy">Comprar · 69,95 €</a>'), out);
  // Retail as plain text, never a .product-price that cart.js would rewrite.
  assert.ok(!out.includes("product-price"), out);
});

test("out of stock, retired or unknown: 'Agotado · ver alternativas' to the category", () => {
  for (const [slug, target] of [
    ["2-out-of-stock", "/productos/categoria/plastificadoras/"],
    ["3-retired", "/productos/categoria/pizarras/"],
    ["4-no-category", "/productos"],
    ["9-unknown", "/productos"],
  ]) {
    const out = render(buy(slug));
    assert.ok(out.includes(`<a href="${target}" class="site-btn-ghost guide-buy">Agotado · ver alternativas</a>`), `${slug}: ${out}`);
  }
});

test("guide-buy on anything but a catalogue product page becomes a plain link", () => {
  const out = render('<a href="https://maker.example/p/1" class="guide-buy">Comprar</a>');
  assert.ok(out.includes('<a href="https://maker.example/p/1">Comprar</a>'), out);
  assert.ok(!out.includes("guide-buy") && !out.includes("site-btn"), out);
});

test("a plain link to a product no longer sold is pointed at its category", () => {
  const out = render("Mira la [pizarra](/productos/3-retired) y la [plastificadora](/productos/1-in-stock).");
  assert.ok(out.includes('<a href="/productos/categoria/pizarras/">pizarra</a>'), out);
  assert.ok(out.includes('<a href="/productos/1-in-stock">plastificadora</a>'), out);
});

test("a photo link to a retired product is redirected too; an out-of-stock one is kept", () => {
  const img = (slug) => `<a href="/productos/${slug}"><img src="/uploads/a.webp" alt="x" width="320"></a>`;
  assert.ok(render(img("3-retired")).includes('href="/productos/categoria/pizarras/"'));
  // Its page still exists (with an "Agotado" badge), so the link is fine as is.
  assert.ok(render(img("2-out-of-stock")).includes('href="/productos/2-out-of-stock"'));
});

test("category and brand links are not product links and are left alone", () => {
  const out = render("[todas](/productos/categoria/pizarras/) y [marca](/productos/marca/nobo/)");
  assert.ok(out.includes('href="/productos/categoria/pizarras/"') && out.includes('href="/productos/marca/nobo/"'), out);
});

test("empty input stays empty", () => {
  assert.equal(renderCatalogueLinks("", lookup), "");
});
