import { readFileSync } from "node:fs";
import { normalizeForSearch } from "../../utils/text.js";
import {
  DEFAULT_SUPPLIER_CODE,
  SELLABLE_STATUS,
  TITLE_DESC_CODE,
  BODY_DESC_CODE,
  DEFAULT_MARGIN,
  DEFAULT_VAT_RATE,
} from "./mapping.js";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function toSlug(text) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

function supplierProducts(data, supplierCode) {
  const block = data.root.Products.find((b) => b.supplierCode === supplierCode);
  return block?.Product || [];
}

function textValue(descriptions, code) {
  const entry = descriptions?.find((d) => d.DescCode === code);
  return entry?.Texts?.Text?.[0]?.Value || "";
}

// Classifications carries every ancestor level (e.g. level 1 "Escolar",
// level 2 "Agendas escolares") — the deepest one is the most useful category.
function mostSpecificCategory(classifications) {
  if (!classifications?.length) return "";
  const deepest = classifications.reduce((a, b) =>
    Number(b.Level) > Number(a.Level) ? b : a,
  );
  return deepest.ClassDescription || "";
}

// Prices is an array of date-ranged blocks; take the first "purchase" entry
// found (products in this feed only ever carry one active price block).
function purchasePriceExVat(priceBlocks) {
  for (const block of priceBlocks || []) {
    const entry = block.Price?.find((p) => p.priceType === "purchase");
    const line = entry?.PriceLines?.PriceLine?.[0];
    if (line) return parseFloat(line.PriceExcTax) || 0;
  }
  return 0;
}

function activeImageUrl(links) {
  const active = links?.find((l) => l.Active === "1" && l.Url);
  return active?.Url || null;
}

function sumStock(stockByWarehouse, id) {
  let total = 0;
  for (const qtyById of stockByWarehouse) total += qtyById.get(id) || 0;
  return total;
}

// Joins the 5 feed files by numeric product `id` (used as our sku) into
// normalized product rows. Only Status === "VAL" products are included.
// RelationedProducts (variant/family grouping — color, alternative, compared,
// complementary) is not ingested: it's a separate ~200MB feed, unrelated to
// catalog/price/stock, and not needed for catalog → cart → reservation.
export function joinLiderpapelCatalog(
  paths,
  {
    supplierCode = DEFAULT_SUPPLIER_CODE,
    marginPct = DEFAULT_MARGIN,
    vatRate = DEFAULT_VAT_RATE,
  } = {},
) {
  if (!supplierCode) {
    throw new Error("Código de proveedor de Liderpapel no configurado");
  }

  const catalog = supplierProducts(readJson(paths.catalog), supplierCode);
  const descriptions = supplierProducts(readJson(paths.descriptions), supplierCode);
  const prices = supplierProducts(readJson(paths.prices), supplierCode);
  const multimedia = supplierProducts(readJson(paths.multimedia), supplierCode);

  const stocksData = readJson(paths.stocks);
  const warehouseBlock = stocksData.root.Storage.find(
    (b) => b.supplierCode === supplierCode,
  );
  const stockByWarehouse = (warehouseBlock?.Stocks || []).map((wh) => {
    const qtyById = new Map();
    for (const p of wh.Products?.Product || []) {
      qtyById.set(p.id, parseInt(p.Stock?.[0]?.AvailableQuantity, 10) || 0);
    }
    return qtyById;
  });

  const descById = new Map(descriptions.map((p) => [p.id, p.Descriptions?.Description]));
  const priceById = new Map(prices.map((p) => [p.id, p.Prices]));
  const imageById = new Map(
    multimedia.map((p) => [p.id, p.MultimediaLinks?.MultimediaLink]),
  );

  const products = new Map();
  for (const p of catalog) {
    if (p.Status !== SELLABLE_STATUS || !p.id) continue;
    const id = p.id;

    const descs = descById.get(id);
    const name = textValue(descs, TITLE_DESC_CODE) || id;
    const category = mostSpecificCategory(p.Classifications?.Classification);
    const purchase = purchasePriceExVat(priceById.get(id));

    products.set(id, {
      sku: id,
      slug: toSlug(`${id}-${name}`),
      name,
      description: textValue(descs, BODY_DESC_CODE),
      category,
      search_text: normalizeForSearch(`${name} ${category}`),
      price_cents: Math.round(purchase * (1 + marginPct) * (1 + vatRate) * 100),
      stock_qty: sumStock(stockByWarehouse, id),
      image_url: activeImageUrl(imageById.get(id)),
      feed_active: 1,
    });
  }

  return products;
}
