import { Router } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import db, { getConfig } from "../db/database.js";
import { mdToPlain, buildFaqLd } from "../content/structured-data.js";
import { toSlug } from "../sync/liderpapel/parse.js";
import { isSmtpConfigured } from "../mail/mailer.js";
import { normalizeForSearch } from "../utils/text.js";

// GET /api/knowledge — everything the WhatsApp / web-chat lead bot
// (hermes-sandbox/scripts/whatsapp-lead-bot) may answer a visitor from. The
// bot says nothing that is not in this payload, so what is missing here is
// what the bot "doesn't know". Same shape as biglobster's src/knowledge.js:
// business, operational_facts, pages, products, faq, articles.
//
// Sizes matter: a catalogue client has ~14,500 products and the whole
// payload goes into one model prompt per turn. Products are therefore a
// sample (our owned sheets and in-stock items first) plus the category list,
// which is where the bot sends a visitor for anything the sample lacks.

const router = Router();

const PAGE_URLS = {
  index: "/",
  quienes: "/quienes-somos",
  servicios: "/servicios",
  contacto: "/contacto",
};
const MAX_PAGE_CHARS = 2000;
const MAX_ARTICLE_CHARS = 1500;
const MAX_EXCERPT_CHARS = 300;
const MAX_PRODUCT_DESC_CHARS = 500;
const MAX_PRODUCTS = 60;
const MAX_CATEGORIES = 200;
const MAX_FAQ_ITEMS = 20;

function tokensMatch(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function truncate(text, maxLength) {
  if (!text) return text;
  if (text.length > maxLength) {
    return text.slice(0, maxLength) + "…";
  }
  return text;
}

function nonEmpty(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

// Config keys that describe the business; secrets never appear here (the
// allow-list is the boundary, not the table).
const BUSINESS_KEYS = [
  "company_name",
  "sector",
  "legal_name",
  "whatsapp_number",
  "biz_type",
  "biz_street",
  "biz_city",
  "biz_postal_code",
  "biz_region",
  "biz_country",
  "biz_phone",
  "biz_hours",
  "biz_price_range",
  "biz_facebook",
  "biz_instagram",
];

export function buildBusiness() {
  const business = {};
  for (const key of BUSINESS_KEYS) {
    const value = getConfig(key);
    if (nonEmpty(value)) business[key] = value;
  }
  const siteUrl = process.env.SITE_URL || getConfig("site_url");
  if (nonEmpty(siteUrl)) business.site_url = String(siteUrl).replace(/\/+$/, "");
  return business;
}

// The four editable pages. `text` is what the bot reads: the body when the
// page has one (only index does), else the description — the panel stores
// quienes/servicios/contacto's prose in `page_*_desc`, and the old code
// dropped it whenever a subtitle was also set. `body` stays for callers
// that read it.
export function buildPages() {
  const pages = {};
  for (const [name, url] of Object.entries(PAGE_URLS)) {
    const title = getConfig(`page_${name}_title`);
    const subtitle = getConfig(`page_${name}_subtitle`);
    const desc = getConfig(`page_${name}_desc`);
    const body = getConfig(`page_${name}_body`);
    if (!nonEmpty(title) && !nonEmpty(body) && !nonEmpty(desc)) continue;
    const text = mdToPlain([subtitle, body || desc].filter(nonEmpty).join("\n\n"));
    pages[name] = {
      title: title || "",
      url,
      description: subtitle || desc || "",
      body: truncate(body || "", MAX_PAGE_CHARS),
      text: truncate(text, MAX_PAGE_CHARS),
    };
  }
  return pages;
}

function publishedArticles() {
  return db
    .prepare(
      `SELECT title, slug, excerpt, content FROM articles
       WHERE status = 'published'
       ORDER BY datetime(created_at) DESC, id DESC
       LIMIT 30`
    )
    .all();
}

export function buildArticles(rows) {
  return rows.map((article) => ({
    title: article.title,
    slug: article.slug,
    url: `/blog/${article.slug}`,
    excerpt: truncate(article.excerpt || mdToPlain(article.content).slice(0, MAX_EXCERPT_CHARS), MAX_EXCERPT_CHARS),
    body: truncate(article.content, MAX_ARTICLE_CHARS),
  }));
}

// Q&A pairs from the FAQ blocks the content agents write into posts (the
// same parser that emits the FAQPage JSON-LD), deduplicated by question.
export function buildFaq(rows) {
  const seen = new Set();
  const items = [];
  for (const article of rows) {
    const ld = buildFaqLd(article.content);
    if (!ld) continue;
    for (const entry of ld.mainEntity) {
      const q = String(entry.name || "").trim();
      const key = q.toLowerCase();
      if (!q || seen.has(key)) continue;
      seen.add(key);
      items.push({ q, a: entry.acceptedAnswer.text, url: `/blog/${article.slug}` });
      if (items.length >= MAX_FAQ_ITEMS) return { es: items };
    }
  }
  return items.length ? { es: items } : {};
}

export function categoryUrl(category) {
  return `/productos/categoria/${toSlug(category)}/`;
}

// A sample, not the catalogue: owned sheets first (the copy we wrote), then
// in stock, then name. `updated_at` is useless for this — the sync rewrites
// it on every SKU every run, so "most recent" was an arbitrary 50.
function sampleProducts() {
  return db
    .prepare(
      `SELECT p.sku, p.slug, p.name, p.description, p.category, p.price_cents, p.stock_qty,
              c.display_name AS owned_name, c.description_md AS owned_description
       FROM products p
       LEFT JOIN product_content c ON c.sku = p.sku AND c.status = 'owned'
       WHERE p.active = 1 AND p.feed_active = 1
       ORDER BY (c.sku IS NOT NULL) DESC, (p.stock_qty > 0) DESC, p.name COLLATE NOCASE
       LIMIT ?`
    )
    .all(MAX_PRODUCTS);
}

export function buildProducts(rows) {
  return rows.map((p) => ({
    sku: p.sku,
    name: p.owned_name || p.name,
    description: truncate(mdToPlain(p.owned_description || p.description || ""), MAX_PRODUCT_DESC_CHARS),
    category: p.category || "",
    category_url: p.category ? categoryUrl(p.category) : null,
    price_eur: p.price_cents / 100,
    vat_included: true,
    in_stock: p.stock_qty > 0,
    url: `/productos/${p.slug}`,
  }));
}

function catalogueStats() {
  const total = db
    .prepare(`SELECT COUNT(*) AS n FROM products WHERE active = 1 AND feed_active = 1`)
    .get().n;
  const categories = db
    .prepare(
      `SELECT category, COUNT(*) AS n, SUM(stock_qty > 0) AS in_stock
       FROM products
       WHERE active = 1 AND feed_active = 1 AND category IS NOT NULL AND category != ''
       GROUP BY category
       ORDER BY n DESC, category COLLATE NOCASE
       LIMIT ?`
    )
    .all(MAX_CATEGORIES)
    .map((c) => ({ name: c.category, url: categoryUrl(c.category), products: c.n, in_stock: c.in_stock }));
  return { total, categories };
}

// Every line states what the code does for this deployment, read from the
// same config the pages are built from — never a promise the site cannot keep.
export function buildOperationalFacts({ productCount, categoryCount, sampleSize, mailConfigured }) {
  const facts = [];
  facts.push(
    `El formulario de contacto está en /contacto.${mailConfigured ? " Las respuestas llegan por email." : ""}`
  );
  if (nonEmpty(getConfig("biz_hours"))) facts.push(`Horario: ${getConfig("biz_hours")}.`);
  if (nonEmpty(getConfig("biz_phone"))) facts.push(`Teléfono: ${getConfig("biz_phone")}.`);
  if (productCount > 0) {
    facts.push(
      `El catálogo online (/productos/) tiene ${productCount} productos en ${categoryCount} categorías; aquí solo aparece una muestra de ${sampleSize}, el resto se encuentra por categoría o con el buscador del catálogo.`
    );
    facts.push("Los precios del catálogo son de venta al público con IVA incluido.");
    facts.push(
      "Los pedidos se hacen desde el catálogo con nombre y email (el teléfono es opcional) y quedan confirmados cuando el negocio los acepta."
    );
    facts.push(
      nonEmpty(getConfig("bank_iban"))
        ? "El pago es por transferencia bancaria: los datos se envían al confirmar el pedido."
        : "Se paga al recibir el pedido; no hay pago online por adelantado."
    );
    if (nonEmpty(getConfig("sales_shipping_text"))) facts.push(`Envíos: ${getConfig("sales_shipping_text")}`);
    if (getConfig("b2b_enabled") === "1") {
      facts.push("Hay precios para profesionales con cuenta propia en /profesionales; las cuentas las crea el negocio.");
    }
  }
  return facts;
}

export function buildKnowledge() {
  const articleRows = publishedArticles();
  const { total, categories } = catalogueStats();
  const products = buildProducts(sampleProducts());
  const payload = {
    business: buildBusiness(),
    operational_facts: buildOperationalFacts({
      productCount: total,
      categoryCount: categories.length,
      sampleSize: products.length,
      mailConfigured: isSmtpConfigured(),
    }),
    pages: buildPages(),
    products,
    categories,
    // search_path: the bot queries it with the visitor's message on every
    // turn, so the model sees the real products (slug, price) for what was
    // asked instead of guessing from the sample -- it invented three pens
    // with prices and 404 links on Shoroban's first day (2026-10-15).
    catalogue: { product_count: total, sample_size: products.length, search_path: "/api/knowledge/search" },
    faq: buildFaq(articleRows),
    articles: buildArticles(articleRows),
  };
  // The etag describes the content, so it must not hash the timestamp.
  payload.etag = createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
  payload.generated_at = new Date().toISOString();
  return payload;
}

function authorize(req, res) {
  const configured = (process.env.KNOWLEDGE_API_TOKEN || "").trim();
  // If no token is configured, the feature is off — return 404 to keep it invisible
  if (!configured) {
    res.status(404).json({ error: "not_found" });
    return false;
  }
  const authHeader = (req.headers.authorization || "").trim();
  const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/);
  if (!tokenMatch || !tokensMatch(tokenMatch[1], configured)) {
    res.status(401).json({ error: "unauthorized" });
    return false;
  }
  return true;
}

const MAX_SEARCH_TERMS = 8;
const DEFAULT_SEARCH_LIMIT = 8;
const MAX_SEARCH_LIMIT = 20;

// Same matching as the storefront's GET /api/products?q= (every word, any
// order, against the feed's text and ours), with one difference that matters
// for a chat: a visitor writes "necesito una pluma de buena calidad", and
// requiring every word kills the search. So: all words first; if nothing
// matches, any word, ranked by how many matched, in stock first.
export function searchCatalogue(q, limit = DEFAULT_SEARCH_LIMIT) {
  const terms = normalizeForSearch(q || "").split(/\s+/).filter((t) => t.length > 1).slice(0, MAX_SEARCH_TERMS);
  const n = Math.min(Math.max(Number(limit) || DEFAULT_SEARCH_LIMIT, 1), MAX_SEARCH_LIMIT);
  if (!terms.length) return { terms, products: [], categories: [] };
  const params = {};
  terms.forEach((term, i) => {
    params[`t${i}`] = `%${term}%`;
  });
  const hit = (i) => `(p.search_text LIKE @t${i} OR c.search_text LIKE @t${i})`;
  const score = terms.map((_, i) => `(${hit(i)})`).join(" + ");
  const select = `SELECT p.sku, p.slug, p.name, p.description, p.category, p.price_cents, p.stock_qty,
                         c.display_name AS owned_name, c.description_md AS owned_description,
                         (${score}) AS hits
                    FROM products p
                    LEFT JOIN product_content c ON c.sku = p.sku AND c.status = 'owned'
                   WHERE p.active = 1 AND p.feed_active = 1`;
  const order = `ORDER BY hits DESC, (p.stock_qty > 0) DESC, (c.sku IS NOT NULL) DESC, p.name COLLATE NOCASE LIMIT @limit`;
  params.limit = n;
  let rows = db.prepare(`${select} AND ${terms.map((_, i) => hit(i)).join(" AND ")} ${order}`).all(params);
  if (!rows.length && terms.length > 1) {
    rows = db.prepare(`${select} AND (${terms.map((_, i) => hit(i)).join(" OR ")}) ${order}`).all(params);
  }
  const categoryRows = db
    .prepare(
      `SELECT category, COUNT(*) AS n FROM products
        WHERE active = 1 AND feed_active = 1 AND category != ''
          AND (${terms.map((_, i) => `lower(category) LIKE @t${i}`).join(" OR ")})
        GROUP BY category ORDER BY n DESC LIMIT 5`
    )
    .all(params);
  return {
    terms,
    products: buildProducts(rows),
    categories: categoryRows.map((c) => ({ name: c.category, url: categoryUrl(c.category), products: c.n })),
  };
}

router.get("/", (req, res) => {
  if (!authorize(req, res)) return;
  res.json(buildKnowledge());
});

// GET /api/knowledge/search?q=...&limit=8 — the bot's per-turn catalogue lookup.
router.get("/search", (req, res) => {
  if (!authorize(req, res)) return;
  const q = typeof req.query.q === "string" ? req.query.q.slice(0, 300) : "";
  res.json({ query: q, ...searchCatalogue(q, req.query.limit) });
});

export default router;
