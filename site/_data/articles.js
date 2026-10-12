import db, { getConfig } from "../../src/db/database.js";
import { formatContent } from "../../src/content/format-content.js";
import { buildArticleLd, buildFaqLd, mdToPlain } from "../../src/content/structured-data.js";
import { isSameSiteUrl } from "../../src/content/same-site.js";
import { renderCatalogueLinks } from "../../src/content/guide-buttons.js";
import { productSlugsIn, ctaProductSlug } from "../../src/content/guide-links.js";
import { toSlug } from "../../src/sync/liderpapel/parse.js";
import { enrichProduct } from "./lib/enrichProduct.js";

// The catalogue rows the published posts link to — only those, and including
// products no longer sold, which is exactly what renderCatalogueLinks needs to
// tell apart. Queried in chunks to stay well under SQLite's parameter limit.
function catalogueLookup(slugs) {
  const lookup = new Map();
  const list = [...slugs];
  for (let i = 0; i < list.length; i += 500) {
    const chunk = list.slice(i, i + 500);
    const rows = db
      .prepare(
        `SELECT slug, category, price_cents, stock_qty, active, feed_active FROM products WHERE slug IN (${chunk.map(() => "?").join(",")})`,
      )
      .all(...chunk);
    for (const p of rows) {
      const e = enrichProduct(p);
      lookup.set(p.slug, {
        priceDisplay: e.priceDisplay,
        inStock: e.inStock,
        available: p.active === 1 && p.feed_active === 1,
        categoryUrl: p.category ? `/productos/categoria/${toSlug(p.category)}/` : null,
      });
    }
  }
  return lookup;
}

export default function () {
  // Minimal site context for the per-post JSON-LD (publisher name, absolute
  // URLs). site_url is resolved the same way as site/_data/site.js so the LD
  // url/logo match the canonical URLs the rest of the build emits.
  const site = {
    company_name: getConfig("company_name") || "",
    site_url: (process.env.SITE_URL || getConfig("site_url") || "").replace(
      /\/+$/,
      "",
    ),
    logo_ext: getConfig("logo_ext") || "",
  };

  const rows = db
    .prepare(
      "SELECT * FROM articles WHERE status = 'published' ORDER BY created_at DESC",
    )
    .all();

  // Every image URL the catalogue knows, so a post may show the photos of the
  // products it talks about (see formatContent). Empty for a site with no
  // catalogue, which then keeps only /uploads/ images, as before.
  const catalogueImages = new Set(
    db
      .prepare(
        "SELECT image_url AS url FROM products WHERE image_url IS NOT NULL AND image_url != '' UNION SELECT url FROM product_images",
      )
      .all()
      .map((r) => r.url),
  );

  const linkedSlugs = new Set();
  for (const a of rows) {
    for (const s of productSlugsIn(a.content)) linkedSlugs.add(s);
    const cta = ctaProductSlug(a.cta_url);
    if (cta) linkedSlugs.add(cta);
  }
  const lookup = catalogueLookup(linkedSlugs);

  // The post's own CTA button follows the same rule as body links: if its
  // product is no longer sold, it leads to the category instead of a 404.
  const resolveCta = (a) => {
    const slug = ctaProductSlug(a.cta_url);
    const p = slug && lookup.get(slug);
    if (!slug || (p && p.available)) return { url: a.cta_url, label: a.cta_label };
    return { url: p?.categoryUrl || "/productos", label: "Ver alternativas" };
  };

  // Related posts: the 3 most recent OTHER published posts. Rows are already
  // sorted created_at DESC, so this needs no extra query or relevance model —
  // and unlike a hand-picked list, it can never point at a post that later
  // gets unpublished or deleted.
  const asRelated = (a) => ({
    slug: a.slug,
    title: a.title,
    image_url: a.image_url,
    image_alt: a.image_alt,
  });

  return rows.map((a) => {
    const cta = resolveCta(a);
    return {
      ...a,
      cta_url: cta.url,
      cta_label: cta.label,
      contentHtml: renderCatalogueLinks(formatContent(a.content, { catalogueImages }), lookup),
      dateEs: new Date(a.created_at).toLocaleDateString("es-ES"),
      // BlogPosting + (when the post has a FAQ section) FAQPage JSON-LD, emitted
      // per post in site/blog-post.njk. buildFaqLd returns null when no FAQ.
      article_ld: buildArticleLd(a, site),
      faq_ld: buildFaqLd(a.content),
      related: rows.filter((r) => r.id !== a.id).slice(0, 3).map(asRelated),
      badgesList: (a.badges || "").split(",").map((s) => s.trim()).filter(Boolean),
      // A CTA to this same site (e.g. one of its own product pages) stays in the
      // tab; only an external one opens a new tab.
      ctaSameSite: isSameSiteUrl(a.cta_url, site.site_url),
      // Standard 200wpm estimate off the plain-text word count (same markdown
      // stripping the FAQ JSON-LD reuses) — derived from content, not authored,
      // so it can never drift from the actual article.
      readingTime: Math.max(
        1,
        Math.round(mdToPlain(a.content).split(/\s+/).filter(Boolean).length / 200),
      ),
    };
  });
}
