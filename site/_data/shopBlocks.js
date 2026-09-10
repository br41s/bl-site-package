import db, { getConfig } from "../../src/db/database.js";
import { toSlug } from "../../src/sync/liderpapel/parse.js";
import { enrichProduct } from "./lib/enrichProduct.js";
import { orderBlocks, readBlockSettings, SHOP_ORDER_KEY } from "../../src/content/shop-blocks.js";

// The merchandising strip on /productos/. Card fields only, no markdown parsing
// — same discipline as productPages.js: products.js owns description parsing for
// the detail pages, and repeating it here would double that cost every build for
// data a card never shows.
//
// Everything is computed at build time, which is what makes these blocks
// autonomous without a single new job: the nightly Liderpapel sync ends in
// scheduleRebuild() (src/sync/liderpapel/sync.js), so every block re-ranks itself
// once a day on its own. A panel edit goes through setConfig(), which schedules a
// rebuild too.
//
// Every ordering below is deterministic. RANDOM() would look livelier and would
// rewrite _site/ on every build, turning a one-word title edit into a diff across
// the whole catalogue.

const LIVE = "p.active = 1 AND p.feed_active = 1";
// A block is a shop window: an item with no picture is a hole in it, and an item
// with no stock is a promise we cannot keep.
const SELLABLE = `${LIVE} AND p.stock_qty > 0 AND p.image_url IS NOT NULL AND p.image_url != ''`;

// Which reservation states count as a sale.
//
// 'pending' is excluded on purpose: POST /api/reservations is public and
// anonymous, so counting unconfirmed carts would let anyone push a product onto
// the front page by filling one. The cost of that choice is real — a shop that
// never moves its orders out of 'pending' never sees this block at all — which is
// why the panel says so in as many words.
const SOLD_STATUSES = ["confirmed", "ready_for_pickup", "completed"];

function bestSellers(limit) {
  // Ranked by how many separate orders included the product, not by raw units.
  // One office ordering 500 pens is one shop's buying habit, not a best-seller;
  // ten people buying one notebook each is. Units break the tie.
  //
  // SELLABLE, not LIVE: a top seller that is out of stock is a card with a
  // disabled button on the front page. It comes back when the stock does.
  return db
    .prepare(
      `SELECT p.*, SUM(ri.quantity) AS sold_units, COUNT(DISTINCT r.id) AS sold_orders
         FROM reservation_items ri
         JOIN reservations r ON r.id = ri.reservation_id
         JOIN products p ON p.sku = ri.sku
        WHERE r.status IN (${SOLD_STATUSES.map(() => "?").join(",")})
          AND ${SELLABLE}
        GROUP BY p.sku
        ORDER BY sold_orders DESC, sold_units DESC, p.name COLLATE NOCASE
        LIMIT ?`,
    )
    .all(...SOLD_STATUSES, limit)
    .map(enrichProduct);
}

function autoFeatured(limit) {
  // Products whose sheet we wrote ourselves come first: product_content is the
  // copy we control, so those are the pages that actually read like a shop
  // rather than a distributor's warehouse label.
  return db
    .prepare(
      `SELECT p.* FROM products p
         LEFT JOIN product_content c ON c.sku = p.sku AND c.status = 'owned'
        WHERE ${SELLABLE}
        ORDER BY (c.sku IS NOT NULL) DESC, p.stock_qty DESC, p.name COLLATE NOCASE
        LIMIT ?`,
    )
    .all(limit)
    .map(enrichProduct);
}

function newArrivals(limit) {
  // NOTE: the first sync stamps every product with the same created_at, so this
  // block only starts meaning anything from the second sync onward. It still
  // renders something sane in the meantime (id order), rather than nothing.
  return db
    .prepare(
      `SELECT p.* FROM products p
        WHERE ${SELLABLE}
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT ?`,
    )
    .all(limit)
    .map(enrichProduct);
}

// LIVE, not SELLABLE — unlike every automatic block. A pin is an instruction,
// so a product the client chose stays put even with no stock or no photo; the
// card says "Agotado" and the client can see why. Silently dropping their pick
// would look like the panel had lost it.
function pickedProducts(skus, limit) {
  if (skus.length === 0) return [];
  const rows = db
    .prepare(
      `SELECT p.*, c.display_name AS owned_name FROM products p
         LEFT JOIN product_content c ON c.sku = p.sku AND c.status = 'owned'
        WHERE ${LIVE} AND p.sku IN (${skus.map(() => "?").join(",")})`,
    )
    .all(...skus);
  // Our title wins where we have one, exactly as GET /api/products does — the
  // panel's star picker shows that name, so the block must not disagree with it.
  const bySku = new Map(
    rows.map(({ owned_name, ...row }) => [row.sku, enrichProduct({ ...row, name: owned_name || row.name })]),
  );
  // Config order is display order. A pinned SKU that has since gone inactive or
  // dropped out of the feed simply vanishes — leaving a dead card on the front
  // page would be worse than a shorter row, and the client can see it is gone.
  return skus
    .map((sku) => bySku.get(sku))
    .filter(Boolean)
    .slice(0, limit);
}

// Categories and brands are both "group the live catalogue by one column, count
// it, and borrow a picture from one of its products". Neither column is indexed,
// so a GROUP BY with a correlated subquery per group would mean one table scan
// per category; one pass in JS is the same thing productCategoryGroups.js already
// does, and it serves both blocks at once.
function groupFacets() {
  const rows = db
    .prepare(
      `SELECT p.category, p.brand, p.image_url, p.stock_qty, p.name FROM products p
        WHERE ${LIVE}
        ORDER BY (p.stock_qty > 0) DESC, p.name COLLATE NOCASE`,
    )
    .all();

  const categories = new Map();
  const brands = new Map();

  for (const row of rows) {
    for (const [label, target] of [
      [row.category, categories],
      [row.brand, brands],
    ]) {
      const name = (label || "").trim();
      if (!name) continue;
      let group = target.get(name);
      if (!group) {
        group = { label: name, slug: toSlug(name), total: 0, image_url: "" };
        target.set(name, group);
      }
      group.total += 1;
      // Rows arrive in-stock-first, so the first usable picture is the best one.
      if (!group.image_url && row.image_url) group.image_url = row.image_url;
    }
  }

  // A slug is the whole URL of the page a card links to; a label that slugs to
  // nothing (punctuation only) has no page to point at.
  const usable = (groups) => Array.from(groups.values()).filter((g) => g.slug);
  return { categories: usable(categories), brands: usable(brands) };
}

function facetBlock(groups, settings, urlPrefix) {
  const chosen =
    settings.mode === "manual"
      ? settings.items.map((slug) => groups.find((g) => g.slug === slug)).filter(Boolean)
      : [...groups].sort((a, b) => b.total - a.total || a.label.localeCompare(b.label, "es"));
  return chosen.slice(0, settings.limit).map((g) => ({ ...g, url: `${urlPrefix}${g.slug}/` }));
}

export default function () {
  const blocks = [];
  let facets = null;

  // Order comes from config, so the client can put "Novedades" above
  // "Destacados" without a deploy. orderBlocks() appends anything the stored
  // order does not mention, so a block added in a later release still shows up
  // on an instance whose order was saved before it existed.
  for (const block of orderBlocks(getConfig(SHOP_ORDER_KEY))) {
    const settings = readBlockSettings(getConfig, block);
    // Skip the query entirely for a block nobody is going to see.
    if (!settings.enabled) {
      blocks.push({ ...settings, kind: block.kind, layout: block.layout, items: [] });
      continue;
    }

    let items = [];
    if (block.kind === "products") {
      if (settings.mode === "manual") items = pickedProducts(settings.items, settings.limit);
      else if (block.name === "vendidos") items = bestSellers(settings.limit);
      else if (block.name === "novedades") items = newArrivals(settings.limit);
      else items = autoFeatured(settings.limit);
    } else {
      facets = facets || groupFacets();
      const groups = block.kind === "brands" ? facets.brands : facets.categories;
      items = facetBlock(groups, settings, block.kind === "brands" ? "/productos/marca/" : "/productos/categoria/");
    }

    // An empty block hides itself (see shop-block.njk). That is the whole
    // promise of "it runs on its own": "lo más vendido" stays invisible until
    // the shop has confirmed orders, and no page ever shows an empty shelf.
    blocks.push({ ...settings, kind: block.kind, layout: block.layout, items });
  }

  return blocks;
}
