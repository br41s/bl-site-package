import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import db from "../../src/db/database.js";
import { enrichProduct } from "./lib/enrichProduct.js";

marked.setOptions({ breaks: true });

function formatDescription(text) {
  if (!text) return "";
  return sanitizeHtml(marked.parse(text), {
    allowedTags: [
      "p", "br", "h2", "h3", "h4", "ul", "ol", "li", "strong", "em",
      "a", "table", "thead", "tbody", "tr", "td", "th", "blockquote",
    ],
    allowedAttributes: {
      a: ["href", "rel", "target"],
    },
  });
}

// Groups a child table into a Map keyed by sku. Three queries for the whole
// catalog rather than three per product — at ~14k products the per-product
// version turns a fast build into a slow one.
function groupBySku(sql) {
  const grouped = new Map();
  for (const row of db.prepare(sql).all()) {
    const list = grouped.get(row.sku);
    if (list) list.push(row);
    else grouped.set(row.sku, [row]);
  }
  return grouped;
}

// The feed labels documents with their raw filename, e.g.
// "78276_DESTRUCTURA_DOCUMENTOS_FELLOWES_SEGURIDAD.pdf". Drop the sku prefix
// and extension, and give it back its spacing and capitals.
// Feed weights are grams, but they span a cartridge (27 g) to a shredder
// (21,760 g), so anything from a kilo up reads better in kg.
function weightDisplay(grams) {
  if (!grams) return null;
  return grams >= 1000
    ? `${(grams / 1000).toLocaleString("es-ES", { maximumFractionDigits: 2 })} kg`
    : `${grams.toLocaleString("es-ES", { maximumFractionDigits: 0 })} g`;
}

function documentTitle(label) {
  const stem = label.replace(/\.[a-z0-9]+$/i, "").replace(/^\d+[_-]/, "");
  const words = stem.replace(/[_-]+/g, " ").trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : label;
}

// schema.org/Product for the detail page. Built here rather than in the
// template because half the fields are conditional and Nunjucks cannot add
// keys to a dict — the old inline version was stuck emitting the product
// name as its own description.
//
// `gtin` is used in preference to gtin13/gtin14: EAN_UNIDAD holds a 13-digit
// EAN for most products but a 14-digit code for some, and the untyped `gtin`
// property accepts both.
function productJsonLd(p, { descriptionHtml, gallery }) {
  const description = descriptionHtml
    ? descriptionHtml.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()
    : p.name;

  const ld = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: p.name,
    description,
    image: gallery.length ? gallery : p.image_url,
    sku: p.sku,
    offers: {
      "@type": "Offer",
      priceCurrency: "EUR",
      price: p.price_cents / 100,
      availability: p.inStock
        ? "https://schema.org/InStock"
        : "https://schema.org/OutOfStock",
    },
  };

  if (p.brand) ld.brand = { "@type": "Brand", name: p.brand };
  if (p.gtin) ld.gtin = p.gtin;
  if (p.mpn) ld.mpn = p.mpn;
  if (p.weight_grams) {
    ld.weight = { "@type": "QuantitativeValue", value: p.weight_grams, unitCode: "GRM" };
  }
  return ld;
}

export default function () {
  const rows = db
    .prepare(
      "SELECT * FROM products WHERE active = 1 AND feed_active = 1 ORDER BY category, name COLLATE NOCASE",
    )
    .all();

  const features = groupBySku(
    "SELECT sku, name, value FROM product_features ORDER BY sku, position",
  );
  const images = groupBySku(
    "SELECT sku, url FROM product_images ORDER BY sku, position",
  );
  const documents = groupBySku(
    "SELECT sku, url, label FROM product_documents ORDER BY sku, position",
  );

  return rows.map((p) => {
    const enriched = {
      ...enrichProduct(p),
      descriptionHtml: formatDescription(p.description),
      weightDisplay: weightDisplay(p.weight_grams),
      features: features.get(p.sku) || [],
      gallery: (images.get(p.sku) || []).map((i) => i.url),
      documents: (documents.get(p.sku) || []).map((d) => ({
        url: d.url,
        title: documentTitle(d.label),
      })),
    };
    return { ...enriched, jsonLd: productJsonLd(enriched, enriched) };
  });
}
