import { toSlug } from "./sync/liderpapel/parse.js";

// A product that drops out of the distributor's feed, or is hidden in the panel,
// stops being built, and its URL — already indexed — starts answering 404.
// Search Console counts those as errors, and products from the GC2-GC5 blocks
// vanish and come back between syncs, so Google crawled them while absent. When
// the product row still exists its category page is the useful answer; 302, not
// 301, because the product may come back and its own URL should win again.
const PRODUCT_PAGE = /^\/productos\/(\d+-[a-z0-9-]+?)(?:\.html)?$/;
// With the trailing slash: the static mount answers a directory without one
// with a second 301, so a bare `/productos` made every redirect two hops.
const SHOP = "/productos/";

// `findCategory(slug)` → the product's category, or undefined when there is no
// such row. `categoryBuilt(slug)` → whether /productos/categoria/<slug> is built.
export function discontinuedProductHandler({ findCategory, categoryBuilt }) {
  return function discontinuedProducts(req, res, next) {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    const product = req.path.match(PRODUCT_PAGE);
    if (!product) return next();
    const category = findCategory(product[1]);
    if (category === undefined) return next();
    const slug = category && toSlug(category);
    const target = slug && categoryBuilt(slug) ? `${SHOP}categoria/${slug}/` : SHOP;
    res.redirect(302, target);
  };
}
