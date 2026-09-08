import db from "../../src/db/database.js";
import { toSlug } from "../../src/sync/liderpapel/parse.js";
import { enrichProduct } from "./lib/enrichProduct.js";

// One page per brand, mirroring productCategoryGroups.js. These exist because
// the "Marcas" block on /productos/ needs somewhere to send people: the catalogue
// search is client-side and does not read ?q= from the URL, so a brand chip had
// no destination until now.
//
// products.brand is populated by the sync from the feed's "Marca" feature (see
// src/sync/liderpapel/mapping.js) and was, until now, only ever used for
// schema.org markup.
//
// Card fields only — no description markdown parsing, that's products.js's job.
export default function () {
  const rows = db
    .prepare(
      "SELECT * FROM products WHERE active = 1 AND feed_active = 1 AND brand IS NOT NULL AND brand != '' ORDER BY brand, (stock_qty > 0) DESC, name COLLATE NOCASE",
    )
    .all();

  const byBrand = new Map();
  for (const p of rows) {
    const brand = p.brand.trim();
    // A brand whose name slugs to nothing has no URL to live at.
    if (!brand || !toSlug(brand)) continue;
    if (!byBrand.has(brand)) byBrand.set(brand, []);
    byBrand.get(brand).push(enrichProduct(p));
  }

  return Array.from(byBrand, ([brand, products]) => ({
    brand,
    slug: toSlug(brand),
    products,
  }));
}
