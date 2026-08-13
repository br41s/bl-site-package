import { Router } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import db, { getConfig } from "../db/database.js";

const router = Router();

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

// GET /api/knowledge — read-only knowledge base for external WhatsApp bot
router.get("/", (req, res) => {
  const configured = (process.env.KNOWLEDGE_API_TOKEN || "").trim();

  // If no token is configured, the feature is off — return 404 to keep it invisible
  if (!configured) {
    return res.status(404).json({ error: "not_found" });
  }

  // Check Authorization header
  const authHeader = (req.headers.authorization || "").trim();
  const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/);

  if (!tokenMatch || !tokensMatch(tokenMatch[1], configured)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  // Build response payload
  const payload = {
    generated_at: new Date().toISOString(),
    business: {},
    pages: {},
    articles: [],
    products: [],
    operational_facts: [
      "El formulario de contacto está en /contacto y las respuestas se envían por email.",
      "Las reservas se gestionan a través del catálogo de productos y requieren nombre, email y teléfono de contacto.",
    ],
  };

  // Populate business info from config
  const businessKeys = [
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

  for (const key of businessKeys) {
    const value = getConfig(key);
    if (value !== null && value !== "") {
      payload.business[key] = value;
    }
  }

  // Populate pages from config
  const pageNames = ["index", "quienes", "servicios", "contacto"];
  for (const name of pageNames) {
    const title = getConfig(`page_${name}_title`);
    const subtitle = getConfig(`page_${name}_subtitle`);
    const desc = getConfig(`page_${name}_desc`);
    const body = getConfig(`page_${name}_body`);

    if (title || body) {
      const description = subtitle || desc || "";
      payload.pages[name] = {
        title: title || "",
        description,
        body: truncate(body || "", 2000),
      };
    }
  }

  // Fetch published articles (most recent first, limit 30)
  const articles = db
    .prepare(
      `SELECT title, slug, excerpt, content FROM articles
       WHERE status = 'published'
       ORDER BY datetime(created_at) DESC, id DESC
       LIMIT 30`
    )
    .all();

  for (const article of articles) {
    payload.articles.push({
      title: article.title,
      slug: article.slug,
      url: `/blog/${article.slug}/`,
      excerpt: article.excerpt || "",
      body: truncate(article.content, 1500),
    });
  }

  // Fetch active products (most recent first, limit 50)
  const products = db
    .prepare(
      `SELECT sku, slug, name, description, category, price_cents, stock_qty
       FROM products
       WHERE active = 1 AND feed_active = 1
       ORDER BY updated_at DESC
       LIMIT 50`
    )
    .all();

  for (const product of products) {
    payload.products.push({
      sku: product.sku,
      name: product.name,
      description: truncate(product.description || "", 500),
      category: product.category || "",
      price_eur: product.price_cents / 100,
      in_stock: product.stock_qty > 0,
      url: `/productos/${product.slug}/`,
    });
  }

  // Compute etag as sha256 hash (first 16 chars) of JSON payload (excluding etag itself)
  const payloadJson = JSON.stringify(payload);
  const etag = createHash("sha256").update(payloadJson).digest("hex").slice(0, 16);
  payload.etag = etag;

  res.json(payload);
});

export default router;
