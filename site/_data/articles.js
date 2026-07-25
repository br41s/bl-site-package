import db, { getConfig } from "../../src/db/database.js";
import { formatContent } from "../../src/content/format-content.js";
import { buildArticleLd, buildFaqLd } from "../../src/content/structured-data.js";

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
  return rows.map((a) => ({
    ...a,
    contentHtml: formatContent(a.content),
    dateEs: new Date(a.created_at).toLocaleDateString("es-ES"),
    // BlogPosting + (when the post has a FAQ section) FAQPage JSON-LD, emitted
    // per post in site/blog-post.njk. buildFaqLd returns null when no FAQ.
    article_ld: buildArticleLd(a, site),
    faq_ld: buildFaqLd(a.content),
  }));
}
