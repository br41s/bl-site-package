// Links between blog posts and the catalogue, worked out at build time.
//
// A "guide" is a published post whose CTA button points at one of this site's
// own product pages: that is what the Product Guide agent writes. Guides are
// listed on the product pages they link to ("Aparece en estas guías") and on
// the category page of the product they recommend. Plain posts that merely
// mention a product are not listed: a product page should point at the guide
// that compares it, not at every article that happens to link it.

// A product page link as the agents write it: root-relative, no extension.
// Slugs are lowercase letters, digits and hyphens (sync.js pins them), so
// /productos/categoria/... and /productos/marca/... never match.
export const PRODUCT_PATH = /^\/productos\/([a-z0-9-]+)$/;

const PRODUCT_LINK_IN_CONTENT = /(?:\]\(|href=")\/productos\/([a-z0-9-]+)(?=[)"])/g;

// Every product slug a post links to, in markdown or raw HTML.
export function productSlugsIn(content) {
  const slugs = new Set();
  for (const m of String(content || "").matchAll(PRODUCT_LINK_IN_CONTENT)) slugs.add(m[1]);
  return slugs;
}

// The product slug a post's CTA button points at, or null. cta_url is always
// absolute (the API validates it with new URL), so only its path is read.
export function ctaProductSlug(ctaUrl) {
  try {
    const path = new URL(ctaUrl).pathname.replace(/\/+$/, "");
    const m = path.match(PRODUCT_PATH);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

const MAX_PER_PAGE = 3;

// posts: published articles, newest first ({ slug, title, content, cta_url }).
// categoryOf: (productSlug) => category string, or undefined when unknown.
// Returns Maps of { slug, title } lists, at most MAX_PER_PAGE each.
export function buildGuideLinks(posts, categoryOf = () => undefined) {
  const byProduct = new Map();
  const byCategory = new Map();
  const push = (map, key, guide) => {
    if (!map.has(key)) map.set(key, []);
    const list = map.get(key);
    if (list.length < MAX_PER_PAGE) list.push(guide);
  };

  for (const post of posts) {
    const ctaSlug = ctaProductSlug(post.cta_url);
    if (!ctaSlug) continue;
    const guide = { slug: post.slug, title: post.title };
    for (const slug of productSlugsIn(post.content)) push(byProduct, slug, guide);
    // The recommended product is a link of the guide too, even if the body
    // never repeats it.
    if (!productSlugsIn(post.content).has(ctaSlug)) push(byProduct, ctaSlug, guide);
    const category = categoryOf(ctaSlug);
    if (category) push(byCategory, category, guide);
  }
  return { byProduct, byCategory };
}
