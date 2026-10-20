// A catalogue client that moved here from the distributor's own white-label
// shop (Liderpapel / Calipage) arrives with years of indexed URLs of that
// shop. Search Console reported hundreds of them as 404 — all of them one of
// three shapes, so one rule each beats a redirect row per URL:
//
//   /product/172667-bloc-musica….html            the product's feed id is its
//   …/PStores;jsessionid=…?…codProduct=172667…   sku, so → /productos/<slug>
//   /cat/20-plastificadoras.html                 → /productos/categoria/<slug>
//   /searchcat/12-calculadoras-de-bolsillo.html     when we have it, else the shop
//   /PStores?…codCategory=199&elementByPage=48…  a filtered listing → /productos
//
// A target that is gone (product no longer sold, category not built) falls
// back to /productos rather than to a 404, which is what the visitor and the
// crawler were getting. Everything else — including this site's own
// /productos/… — never matches, so a normal request costs one regex test.
const PRODUCT_PAGE = /^\/product\/(\d+)-[^/]*\.html$/;
const CATEGORY_PAGE = /^\/(?:cat|searchcat)\/\d+-([a-z0-9-]+)\.html_?$/;
// `;jsessionid=…` rides on the path of the old shop's session URLs.
const SHOP_PAGE = /^\/(?:product\/|searchcat\/)?PStores(?:;[^?]*)?$/;
const SHOP = "/productos";

// `findSoldSlug(sku)` → slug of a product we still sell, else undefined.
// `categoryExists(slug)` → whether /productos/categoria/<slug> is built.
export function legacyTarget(url, { findSoldSlug, categoryExists }) {
  const { pathname, searchParams } = new URL(url, "http://x");

  const product = pathname.match(PRODUCT_PAGE);
  const shop = SHOP_PAGE.test(pathname);
  if (product || shop) {
    const sku = product ? product[1] : searchParams.get("codProduct");
    const slug = sku && findSoldSlug(sku);
    return slug ? `${SHOP}/${slug}.html` : SHOP;
  }

  const category = pathname.match(CATEGORY_PAGE);
  if (category) {
    return categoryExists(category[1]) ? `${SHOP}/categoria/${category[1]}` : SHOP;
  }

  return null;
}

export function legacyUrlHandler(deps) {
  return function legacyUrls(req, res, next) {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    const target = legacyTarget(req.originalUrl, deps);
    if (target) return res.redirect(301, target);
    next();
  };
}
