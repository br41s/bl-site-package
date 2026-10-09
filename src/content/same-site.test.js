import { test } from "node:test";
import assert from "node:assert/strict";
import { isSameSiteUrl } from "./same-site.js";

test("a CTA on the site's own product page is same-site", () => {
  assert.equal(isSameSiteUrl("https://shop.example/productos/123-x", "https://shop.example"), true);
});

test("www and case do not make the same site look external", () => {
  assert.equal(isSameSiteUrl("https://www.Shop.example/productos/1", "https://shop.example"), true);
  assert.equal(isSameSiteUrl("https://shop.example/x", "https://www.shop.example/"), true);
});

test("another domain, including a subdomain such as an old store, is external", () => {
  assert.equal(isSameSiteUrl("https://tienda.shop.example/store/9", "https://shop.example"), false);
  assert.equal(isSameSiteUrl("https://other.example/p", "https://shop.example"), false);
});

test("with no site_url configured, nothing counts as same-site", () => {
  assert.equal(isSameSiteUrl("https://shop.example/p", ""), false);
  assert.equal(isSameSiteUrl("not a url", "https://shop.example"), false);
});
