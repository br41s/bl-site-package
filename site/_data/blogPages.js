import db from "../../src/db/database.js";

const PAGE_SIZE = 10;

// Card fields only (title/slug/excerpt/image/date) — no markdown rendering,
// JSON-LD, or related-posts computation, that's articles.js's job for the
// per-post detail pages, and re-running it here would double that cost for
// data the listing page never uses.
//
// Eleventy pagination emits zero pages for a zero-length data array, which
// would 404 /blog/ instead of showing the empty state — pre-chunk here and
// fall back to one empty chunk so the page always exists.
export default function () {
  const rows = db
    .prepare("SELECT * FROM articles WHERE status = 'published' ORDER BY created_at DESC")
    .all();
  const posts = rows.map((a) => ({
    ...a,
    dateEs: new Date(a.created_at).toLocaleDateString("es-ES"),
  }));

  if (posts.length === 0) return [[]];

  const pages = [];
  for (let i = 0; i < posts.length; i += PAGE_SIZE) {
    pages.push(posts.slice(i, i + PAGE_SIZE));
  }
  return pages;
}
