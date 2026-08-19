import db from "../../src/db/database.js";
import { toSlug } from "../../src/sync/liderpapel/parse.js";
import { enrichProduct } from "./lib/enrichProduct.js";

// Card fields only (name/slug/image/price/stock) — no description markdown
// parsing here, that's products.js's job for the per-product detail pages.
export default function () {
  const rows = db
    .prepare(
      "SELECT * FROM products WHERE active = 1 AND feed_active = 1 AND category != '' ORDER BY category, (stock_qty > 0) DESC, name COLLATE NOCASE",
    )
    .all();

  const byCategory = new Map();
  for (const p of rows) {
    if (!byCategory.has(p.category)) byCategory.set(p.category, []);
    byCategory.get(p.category).push(enrichProduct(p));
  }

  return Array.from(byCategory, ([category, products]) => ({
    category,
    slug: toSlug(category),
    products,
  }));
}
