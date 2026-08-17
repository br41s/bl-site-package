import db, { getConfig } from "../../src/db/database.js";
import { formatContent } from "../../src/content/format-content.js";
import { buildArticleLd, buildFaqLd, mdToPlain } from "../../src/content/structured-data.js";

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

  return rows.map((a) => ({
    ...a,
    contentHtml: formatContent(a.content),
    dateEs: new Date(a.created_at).toLocaleDateString("es-ES"),
    // BlogPosting + (when the post has a FAQ section) FAQPage JSON-LD, emitted
    // per post in site/blog-post.njk. buildFaqLd returns null when no FAQ.
    article_ld: buildArticleLd(a, site),
    faq_ld: buildFaqLd(a.content),
    related: rows.filter((r) => r.id !== a.id).slice(0, 3).map(asRelated),
    badgesList: (a.badges || "").split(",").map((s) => s.trim()).filter(Boolean),
    // Standard 200wpm estimate off the plain-text word count (same markdown
    // stripping the FAQ JSON-LD reuses) — derived from content, not authored,
    // so it can never drift from the actual article.
    readingTime: Math.max(
      1,
      Math.round(mdToPlain(a.content).split(/\s+/).filter(Boolean).length / 200),
    ),
  }));
}
