import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGuideLinks, ctaProductSlug, productSlugsIn } from "./guide-links.js";

test("product slugs are read from markdown and HTML links, not category/brand links", () => {
  const slugs = productSlugsIn(
    '[a](/productos/1-a) <a href="/productos/2-b"><img src="/uploads/x.webp"></a> [c](/productos/categoria/x/) [d](/productos/marca/y/)',
  );
  assert.deepEqual([...slugs].sort(), ["1-a", "2-b"]);
});

test("the CTA slug comes from an absolute product URL only", () => {
  assert.equal(ctaProductSlug("https://shop.example/productos/123-x"), "123-x");
  assert.equal(ctaProductSlug("https://shop.example/contacto"), null);
  assert.equal(ctaProductSlug("https://shop.example/productos/categoria/x/"), null);
  assert.equal(ctaProductSlug(null), null);
});

test("guides are listed on the products they link and on their CTA product's category", () => {
  const posts = [
    { slug: "guia-nueva", title: "Guía nueva", cta_url: "https://s.example/productos/1-a", content: "[a](/productos/1-a) [b](/productos/2-b)" },
    { slug: "articulo", title: "Artículo", cta_url: "https://s.example/contacto", content: "[a](/productos/1-a)" },
    { slug: "guia-vieja", title: "Guía vieja", cta_url: "https://s.example/productos/3-c", content: "[b](/productos/2-b)" },
  ];
  const categories = { "1-a": "Pizarras", "3-c": "Plastificadoras" };
  const { byProduct, byCategory } = buildGuideLinks(posts, (s) => categories[s]);

  // Plain articles are not guides; newest guide first.
  assert.deepEqual(byProduct.get("1-a").map((g) => g.slug), ["guia-nueva"]);
  assert.deepEqual(byProduct.get("2-b").map((g) => g.slug), ["guia-nueva", "guia-vieja"]);
  // The recommended product counts even when the body never links it.
  assert.deepEqual(byProduct.get("3-c").map((g) => g.slug), ["guia-vieja"]);
  assert.deepEqual(byCategory.get("Pizarras").map((g) => g.title), ["Guía nueva"]);
  assert.deepEqual(byCategory.get("Plastificadoras").map((g) => g.title), ["Guía vieja"]);
});

test("at most three guides per product page", () => {
  const posts = Array.from({ length: 5 }, (_, i) => ({
    slug: `g${i}`, title: `G${i}`, cta_url: "https://s.example/productos/1-a", content: "",
  }));
  assert.equal(buildGuideLinks(posts).byProduct.get("1-a").length, 3);
});
