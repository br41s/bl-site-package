import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { normalizeForSearch } from "../../utils/text.js";
import {
  DEFAULT_SUPPLIER_CODE,
  SELLABLE_STATUS,
  TITLE_DESC_CODE,
  BODY_DESC_CODE,
  FALLBACK_BODY_DESC_CODE,
  GTIN_REF_TYPE,
  MPN_REF_TYPE,
  BRAND_FEATURE_NAME,
  IMAGE_MML_TYPE,
  DOCUMENT_MML_TYPE,
  DEFAULT_PVO_ADJUST_PCT,
  DEFAULT_MARGIN_PCT,
  DEFAULT_VAT_RATE,
} from "./mapping.js";

// Price in cents, VAT included, from an ex-VAT base and a percentage over it.
// The one formula for it: the sync prices every product with it, and
// src/api/pricing.js re-prices the stored catalogue with it when an adjustment
// changes, so the two can never disagree by a cent.
export function pvpCents(baseExVat, pct, vatRate = DEFAULT_VAT_RATE) {
  return Math.round(baseExVat * (1 + pct / 100) * (1 + vatRate) * 100);
}

// The public price of one product row (see mapping.js): the distributor's PVO
// with our adjustment on top or, when the feed gives no PVO, the purchase cost
// at the fallback margin — either way at the product's own VAT rate. null when
// there is nothing to price from (rows synced before these columns existed),
// so a re-price leaves them alone.
export function retailPriceCents(row, adjustPct) {
  const vat = Number.isFinite(row.vat_rate) ? row.vat_rate : DEFAULT_VAT_RATE;
  if (row.pvo_ex_vat > 0) return pvpCents(row.pvo_ex_vat, adjustPct, vat);
  if (row.cost_ex_vat > 0) return pvpCents(row.cost_ex_vat, DEFAULT_MARGIN_PCT, vat);
  return null;
}

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
//
// The purchase price comes in quantity tiers, one PriceLine per MinQuantity,
// and the feed lists the largest pack FIRST: 10 units at 1.98, then 1 unit at
// 2.38 with the distributor's 20 % below-pack supplement already included
// (2,631 of 19,045 products on 2026-08-19). The shop sells single units, so its
// cost is the smallest tier — the unit of sale (AdditionalInfo.UVE) wherever the
// feed states one. Taking PriceLine[0] used to record the pack price as the cost.
function purchasePriceExVat(priceBlocks) {
  for (const block of priceBlocks || []) {
    const entry = block.Price?.find((p) => p.priceType === "purchase");
    const line = smallestTier(entry?.PriceLines?.PriceLine);
    if (line) return parseFloat(line.PriceExcTax) || 0;
  }
  return 0;
}

function smallestTier(lines) {
  let best = null;
  for (const line of lines || []) {
    const parsed = parseInt(line.MinQuantity, 10);
    const qty = Number.isFinite(parsed) ? parsed : 1;
    if (!best || qty < best.qty) best = { qty, line };
  }
  return best?.line || null;
}

// The distributor's suggested retail price for its general catalogue, ex VAT
// (priceType "suggestedCI", see mapping.js). null when the feed gives none.
function suggestedPvoExVat(priceBlocks) {
  for (const block of priceBlocks || []) {
    const entry = block.Price?.find((p) => p.priceType === "suggestedCI");
    const value = parseFloat(entry?.PriceLines?.PriceLine?.[0]?.PriceExcTax);
    if (value > 0) return value;
  }
  return null;
}

// VATRates sits beside Prices on the product's entry in the prices file:
// { VATRate: [{ country: "ES", Value: "21.0" }] }. Returned as a fraction.
function vatRateOf(priceEntry) {
  const value = parseFloat(priceEntry?.VATRates?.VATRate?.[0]?.Value);
  return Number.isFinite(value) && value >= 0 ? value / 100 : DEFAULT_VAT_RATE;
}

// Every active link of one mmlType, in feed order, deduplicated. The feed
// repeats URLs across entries and pads products out with inactive rows
// carrying an empty Url, so both have to be filtered before use.
function activeLinks(links, mmlType) {
  const urls = [];
  for (const link of links || []) {
    if (link.mmlType !== mmlType || link.Active !== "1" || !link.Url) continue;
    if (!urls.includes(link.Url)) urls.push(link.Url);
  }
  return urls;
}

// Filename Liderpapel gave the document, used as its label. Falls back to the
// last path segment, since Name is empty on some entries.
function documentLabel(link, url) {
  return link?.Name || decodeURIComponent(url.split("/").pop() || "");
}

// Fingerprint of the feed facts a product sheet is written from.
//
// Deliberately excludes price and stock. Those change constantly and change
// nothing about the prose — including them would flag every owned sheet for
// review within a day and the signal would be worthless. What it does cover is
// everything an author would have read: the title, the description, the spec
// list, the identifiers and which documents exist.
//
// Values are joined with separators that cannot appear in the parts, so
// {name: "a", value: "b|c"} and {name: "a|b", value: "c"} cannot collide into
// the same hash.
function sourceFingerprint({ name, description, features, documents, gtin, mpn, brand }) {
  const canonical = [
    name || "",
    description || "",
    features.map((f) => `${f.name}\u0000${f.value}`).join("\u0001"),
    documents.map((d) => d.url).join("\u0001"),
    gtin || "",
    mpn || "",
    brand || "",
  ].join("\u0002");
  return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 32);
}

function referenceCode(references, refType) {
  const match = references?.find((r) => r.RefType === refType && r.RefCode);
  return match?.RefCode || null;
}

// Features are already per-language (lang: "es-ES") and carry a display name
// and value, so they need no taxonomy lookup to be presentable. Order is
// preserved: the feed lists them roughly by importance.
function featureList(features) {
  return (features || [])
    .filter((f) => f.FeatureName && f.Value)
    .map((f) => ({ name: f.FeatureName, value: f.Value }));
}

// Weight is grams as a decimal string ("205.0"); dimensions are the packed
// unit's "LxWxH" in mm. Both live under AdditionalInfo rather than Features.
function logisticFacts(additionalInfo) {
  const weight = parseFloat(additionalInfo?.Weight);
  return {
    weight_grams: Number.isFinite(weight) && weight > 0 ? weight : null,
    dimensions_mm:
      additionalInfo?.LogisticInfo?.LogisticUMV?.Dimensions || null,
  };
}

function sumStock(stockByWarehouse, id) {
  let total = 0;
  for (const qtyById of stockByWarehouse) total += qtyById.get(id) || 0;
  return total;
}

// Joins the 5 feed files by numeric product `id` (used as our sku) into
// normalized products. Only Status === "VAL" products are included.
//
// Each map entry is `{ row, features, images, documents }`: `row` is the
// `products` table record, the rest are child collections the sync replaces
// wholesale. They come from data the feed has always carried and the adapter
// previously dropped — Features (the spec table), References (EAN and
// manufacturer reference), and the DOC/IMG multimedia links.
// RelationedProducts (variant/family grouping — color, alternative, compared,
// complementary) is not ingested: it's a separate ~200MB feed, unrelated to
// catalog/price/stock, and not needed for catalog → cart → reservation.
export function joinLiderpapelCatalog(
  paths,
  {
    supplierCode = DEFAULT_SUPPLIER_CODE,
    adjustFor = () => DEFAULT_PVO_ADJUST_PCT,
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
  const priceById = new Map(prices.map((p) => [p.id, p]));
  const linksById = new Map(
    multimedia.map((p) => [p.id, p.MultimediaLinks?.MultimediaLink]),
  );

  const products = new Map();
  for (const p of catalog) {
    if (p.Status !== SELLABLE_STATUS || !p.id) continue;
    const id = p.id;

    const descs = descById.get(id);
    const name = textValue(descs, TITLE_DESC_CODE) || id;
    const category = mostSpecificCategory(p.Classifications?.Classification);
    const priceEntry = priceById.get(id);
    const pricing = {
      cost_ex_vat: purchasePriceExVat(priceEntry?.Prices),
      pvo_ex_vat: suggestedPvoExVat(priceEntry?.Prices),
      vat_rate: vatRateOf(priceEntry),
    };

    const links = linksById.get(id);
    const images = activeLinks(links, IMAGE_MML_TYPE);
    const references = p.References?.Reference;
    const features = featureList(p.Features?.Feature);
    const { weight_grams, dimensions_mm } = logisticFacts(p.AdditionalInfo);

    const description =
      textValue(descs, BODY_DESC_CODE) || textValue(descs, FALLBACK_BODY_DESC_CODE);
    const gtin = referenceCode(references, GTIN_REF_TYPE);
    const mpn = referenceCode(references, MPN_REF_TYPE);
    const brand = features.find((f) => f.name === BRAND_FEATURE_NAME)?.value || null;
    const documents = activeLinks(links, DOCUMENT_MML_TYPE).map((url) => ({
      url,
      label: documentLabel(
        links?.find((l) => l.Url === url),
        url,
      ),
    }));

    products.set(id, {
      row: {
        sku: id,
        slug: toSlug(`${id}-${name}`),
        name,
        description,
        category,
        // Identifiers belong in here because that is what people type. A
        // buyer replacing a cartridge searches "51604A" or the barcode off
        // the box, not a category — and until now neither matched anything.
        search_text: normalizeForSearch(
          [name, category, mpn, gtin].filter(Boolean).join(" "),
        ),
        // Kept so an adjustment change can re-price the catalogue at once,
        // without waiting for the next feed (src/api/pricing.js).
        ...pricing,
        price_cents: retailPriceCents(pricing, adjustFor(category)) ?? 0,
        stock_qty: sumStock(stockByWarehouse, id),
        image_url: images[0] || null,
        gtin,
        mpn,
        brand,
        weight_grams,
        dimensions_mm,
        source_fingerprint: sourceFingerprint({
          name,
          description,
          features,
          documents,
          gtin,
          mpn,
          brand,
        }),
        feed_active: 1,
      },
      // Child rows, replaced wholesale on every sync (see sync.js). Kept off
      // `row` so the products upsert can spread it straight into the
      // statement's named parameters.
      features,
      images,
      documents,
    });
  }

  return products;
}
