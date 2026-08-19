import db from "../../src/db/database.js";
import { enrichProduct } from "./lib/enrichProduct.js";

const PAGE_SIZE = 60;

// Card fields only (no description markdown parsing — that's products.js's
// job for the per-product detail pages, and re-running it here for all rows
// would double that cost on every build for data the grid never uses).
//
// Eleventy pagination emits zero pages for a zero-length data array, which
// would 404 /productos/ instead of showing the empty state — pre-chunk here
// and fall back to one empty chunk so the page always exists.
export default function () {
  const rows = db
    .prepare(
      "SELECT * FROM products WHERE active = 1 AND feed_active = 1 ORDER BY category, (stock_qty > 0) DESC, name COLLATE NOCASE",
    )
    .all();
  const products = rows.map(enrichProduct);

  if (products.length === 0) return [[]];

  const pages = [];
  for (let i = 0; i < products.length; i += PAGE_SIZE) {
    pages.push(products.slice(i, i + PAGE_SIZE));
  }
  return pages;
}
