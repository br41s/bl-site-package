import { PRODUCT_PATH } from "./guide-links.js";

// Rewrites the catalogue links in a post's already-sanitized HTML, at build
// time, against the catalogue as it stands after the last sync.
//
// - <a href="/productos/SLUG" class="guide-buy"> is the Product Guide agent's
//   buy button. The agent never writes a price (it would go stale); the build
//   writes the current one, or "Agotado · ver alternativas" pointing at the
//   category when the product is out of stock or no longer sold.
// - Any other link to a product that is no longer sold (its page is not built,
//   so it would 404) is pointed at that product's category instead.
// - guide-buy on a link that is not one of this site's product pages loses the
//   class: the button can only ever lead to the shop's own product pages.
//
// lookup: Map of product slug -> { priceDisplay, inStock, available,
// categoryUrl }. `available` = active and in the feed, i.e. the product page
// exists. Products missing from the map are treated as gone.

const ANCHOR = /<a\b([^>]*)>([\s\S]*?)<\/a>/g;

const escapeHtml = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

function attr(attrs, name) {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? m[1] : null;
}

export function renderCatalogueLinks(html, lookup) {
  if (!html) return html;
  return html.replace(ANCHOR, (whole, attrs, inner) => {
    const href = attr(attrs, "href") || "";
    const isBuy = (attr(attrs, "class") || "").split(/\s+/).includes("guide-buy");
    const m = href.match(PRODUCT_PATH);

    if (!m) {
      return isBuy ? `<a${attrs.replace(/\s*class="[^"]*"/, "")}>${inner}</a>` : whole;
    }

    const p = lookup.get(m[1]);
    const fallback = p?.categoryUrl || "/productos";

    if (isBuy) {
      if (p && p.available && p.inStock) {
        // Retail, VAT included, as plain text. Deliberately NOT a .product-price
        // span: cart.js would rewrite it for a signed-in trade account into a
        // net price plus a struck-through one, inside a button and without the
        // "IVA no incluido" note. The product page shows the trade price.
        return `<a href="/productos/${m[1]}" class="site-btn guide-buy">Comprar · ${escapeHtml(p.priceDisplay)}</a>`;
      }
      return `<a href="${fallback}" class="site-btn-ghost guide-buy">Agotado · ver alternativas</a>`;
    }

    if (p && p.available) return whole;
    return `<a${attrs.replace(/\bhref="[^"]*"/, `href="${fallback}"`)}>${inner}</a>`;
  });
}
