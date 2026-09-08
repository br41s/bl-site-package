// The merchandising blocks that render at the top of /productos/, in the order
// they appear. Shared on purpose: the Eleventy provider (site/_data/shopBlocks.js)
// reads these settings to build the blocks, and POST /api/site/texts
// (src/api/site.js) derives its write allowlist and validators from the same
// registry — two hand-maintained lists is exactly how PUBLIC_CONFIG_KEYS and
// the panel allowlist drifted apart.
//
// `curated: true` means the client can pin the picks by hand from the panel;
// those blocks get a _mode and an _items key. "vendidos" and "novedades" are
// deliberately auto-only — a hand-picked best-seller is a lie, and a
// hand-picked "new arrival" is just a featured product, which is its own block.
export const SHOP_BLOCKS = [
  { name: "vendidos", kind: "products", curated: false },
  { name: "destacados", kind: "products", curated: true },
  { name: "novedades", kind: "products", curated: false },
  { name: "categorias", kind: "categories", curated: true },
  { name: "marcas", kind: "brands", curated: true },
];

// A block never renders more than this many items however the config is set.
// The blocks sit above a 60-product grid; past a couple of rows they stop being
// merchandising and become a second, worse catalogue.
export const MAX_BLOCK_LIMIT = 24;

// Cap on a manual pick list. Generous — the point is to stop a paste of the
// whole catalogue turning the landing page into a 14k-row render, not to
// second-guess a client who wants 30 favourites.
const MAX_ITEMS = 60;

// The one setting that is about the strip as a whole rather than one block.
export const SHOP_ORDER_KEY = "shop_blocks_order";

export const SHOP_BLOCK_KEYS = [
  SHOP_ORDER_KEY,
  ...SHOP_BLOCKS.flatMap(({ name, curated }) => [
    `shop_${name}_enabled`,
    `shop_${name}_title`,
    `shop_${name}_limit`,
    ...(curated ? [`shop_${name}_mode`, `shop_${name}_items`] : []),
  ]),
];

/**
 * The blocks in the order they should render.
 *
 * Anything the stored order does not mention is appended in registry order
 * rather than dropped. That is the whole point: a release that adds a sixth
 * block must show up on instances whose saved order was written when there were
 * five, instead of silently going missing on every existing customer. Unknown
 * names are ignored for the mirror-image reason — a block we removed should not
 * break the strip.
 */
export function orderBlocks(raw) {
  const known = new Map(SHOP_BLOCKS.map((b) => [b.name, b]));
  const ordered = [];
  for (const name of parseItemList(raw)) {
    const block = known.get(name);
    if (!block || ordered.includes(block)) continue;
    ordered.push(block);
  }
  for (const block of SHOP_BLOCKS) {
    if (!ordered.includes(block)) ordered.push(block);
  }
  return ordered;
}

// Same contract as APPEARANCE_VALIDATORS in src/api/site.js: return false and
// the whole request is rejected with a 400 before anything is written. Titles
// and item lists are absent on purpose — titles are escaped by Nunjucks at
// render time, and item lists are matched against the database by the provider,
// so an unknown SKU is dropped rather than trusted.
export const SHOP_BLOCK_VALIDATORS = Object.fromEntries([
  [
    SHOP_ORDER_KEY,
    (v) => parseItemList(v).every((name) => SHOP_BLOCKS.some((b) => b.name === name)),
  ],
  ...SHOP_BLOCKS.flatMap(({ name, curated }) => [
    [`shop_${name}_enabled`, (v) => ["", "0", "1"].includes(String(v))],
    [
      `shop_${name}_limit`,
      (v) => v === "" || (/^\d+$/.test(String(v)) && Number(v) >= 1 && Number(v) <= MAX_BLOCK_LIMIT),
    ],
    ...(curated ? [[`shop_${name}_mode`, (v) => ["", "auto", "manual"].includes(String(v))]] : []),
  ]),
]);

/**
 * Split a stored pick list into clean entries. Accepts newlines or commas
 * because the panel writes newlines but a client pasting from a spreadsheet
 * will produce commas, and silently ignoring their input is worse than
 * accepting both. Order is preserved — it is the display order — and
 * duplicates are dropped so a double-click on a star cannot show a product
 * twice.
 */
export function parseItemList(raw) {
  const seen = new Set();
  const items = [];
  for (const entry of String(raw || "").split(/[\n,]+/)) {
    const value = entry.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    items.push(value);
    if (items.length >= MAX_ITEMS) break;
  }
  return items;
}

/**
 * Read one block's settings out of config. `read` is injected rather than
 * imported so this module stays free of a database import — src/api/site.js
 * pulls it in on every request.
 */
export function readBlockSettings(read, { name, curated }, defaults = {}) {
  const rawLimit = Number.parseInt(read(`shop_${name}_limit`), 10);
  const mode = curated ? read(`shop_${name}_mode`) || "auto" : "auto";
  return {
    name,
    // Unset means off: a block only appears once someone (or seedConfigDefault)
    // has said so, which keeps an upgraded instance from sprouting blocks
    // before its owner has seen them.
    enabled: read(`shop_${name}_enabled`) === "1",
    title: read(`shop_${name}_title`) || defaults.title || "",
    limit: Number.isInteger(rawLimit)
      ? Math.min(Math.max(rawLimit, 1), MAX_BLOCK_LIMIT)
      : defaults.limit || 8,
    mode: mode === "manual" ? "manual" : "auto",
    items: curated ? parseItemList(read(`shop_${name}_items`)) : [],
  };
}
