import { Router } from "express";
import db from "../db/database.js";
import { requireAuth } from "../middleware/auth.js";
import { scheduleRebuild } from "../build/rebuild.js";

// The write path for product copy we own. Mounted on its own prefix rather
// than under /api/products because everything here is authenticated and
// agent-facing, while /api/products is mostly public reads.
const router = Router();

const MAX_DISPLAY_NAME = 200;
const MAX_DESCRIPTION = 20000;
const MAX_EVIDENCE = 20;

// A sheet may be published once it carries the things a good sheet has. This
// is the stop rule, and it is deliberately code rather than the model's own
// judgement: an objective checklist can be audited, re-run, and reported as a
// number, and it cannot talk itself into being finished.
//
// Note what is NOT required: a barcode. About 1,100 products in a 14,487
// catalogue have no EAN_UNIDAD at all, and refusing to ever publish those
// would quietly strand them forever. What is required is consistency — if the
// feed knows the barcode, our copy has to have recorded the same one.
function ownershipBlockers(sku, content) {
  const product = db.prepare("SELECT * FROM products WHERE sku = ?").get(sku);
  const featureCount = db
    .prepare("SELECT COUNT(*) AS n FROM product_features WHERE sku = ?")
    .get(sku).n;

  const blockers = [];
  if (!content.display_name) blockers.push("falta el título propio (display_name)");
  if (!content.description_md) blockers.push("falta el cuerpo (description_md)");
  if (featureCount === 0) blockers.push("el producto no tiene características en el feed");
  if (product.gtin && content.gtin !== product.gtin) {
    blockers.push("el EAN guardado no coincide con el del feed");
  }
  if (product.mpn && content.mpn !== product.mpn) {
    blockers.push("la referencia de fabricante no coincide con la del feed");
  }
  return blockers;
}

function feedFactsFor(sku) {
  const product = db
    .prepare("SELECT * FROM products WHERE sku = ? AND active = 1 AND feed_active = 1")
    .get(sku);
  if (!product) return null;

  return {
    product,
    features: db
      .prepare("SELECT name, value FROM product_features WHERE sku = ? ORDER BY position")
      .all(sku),
    documents: db
      .prepare("SELECT url, label FROM product_documents WHERE sku = ? ORDER BY position")
      .all(sku),
    images: db
      .prepare("SELECT url FROM product_images WHERE sku = ? ORDER BY position")
      .all(sku)
      .map((r) => r.url),
  };
}

// GET /api/product-content/queue — what to work on next.
//
// Two lists, because they are different jobs. `pending` is a sheet nobody has
// written yet; `review` is a sheet we already own whose underlying facts have
// since moved, which needs a human or a re-run rather than fresh prose.
router.get("/queue", requireAuth, (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 100);

  // Ordered by what a wrong answer costs and a right one earns: in stock
  // first (we cannot sell what we do not have), then by price.
  const pending = db
    .prepare(
      `SELECT p.sku, p.name, p.category, p.price_cents, p.stock_qty, p.gtin, p.mpn, p.brand,
              (SELECT COUNT(*) FROM product_features f WHERE f.sku = p.sku) AS feature_count,
              (SELECT COUNT(*) FROM product_documents d WHERE d.sku = p.sku) AS document_count,
              c.status AS content_status
         FROM products p
         LEFT JOIN product_content c ON c.sku = p.sku
        WHERE p.active = 1 AND p.feed_active = 1
          AND p.stock_qty > 0
          AND (c.status IS NULL OR c.status <> 'owned')
        ORDER BY p.price_cents DESC
        LIMIT ?`,
    )
    .all(limit);

  const review = db
    .prepare(
      `SELECT p.sku, p.name, p.price_cents, c.display_name, c.updated_at
         FROM product_content c
         JOIN products p ON p.sku = c.sku
        WHERE c.status = 'owned'
          AND c.source_fingerprint IS NOT p.source_fingerprint
        ORDER BY p.price_cents DESC
        LIMIT ?`,
    )
    .all(limit);

  const totals = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM products WHERE active = 1 AND feed_active = 1) AS products,
         (SELECT COUNT(*) FROM product_content WHERE status = 'owned') AS owned,
         (SELECT COUNT(*) FROM product_content c JOIN products p ON p.sku = c.sku
           WHERE c.status = 'owned' AND c.source_fingerprint IS NOT p.source_fingerprint) AS drifted`,
    )
    .get();

  res.json({ pending, review, totals });
});

// GET /api/product-content/:sku — everything needed to write this one sheet:
// the feed's facts, and whatever copy already exists.
router.get("/:sku", requireAuth, (req, res) => {
  const facts = feedFactsFor(req.params.sku);
  if (!facts) return res.status(404).json({ error: "Producto no encontrado" });

  const content =
    db.prepare("SELECT * FROM product_content WHERE sku = ?").get(req.params.sku) || null;

  res.json({
    sku: facts.product.sku,
    feed: {
      name: facts.product.name,
      description: facts.product.description,
      category: facts.product.category,
      gtin: facts.product.gtin,
      mpn: facts.product.mpn,
      brand: facts.product.brand,
      weight_grams: facts.product.weight_grams,
      dimensions_mm: facts.product.dimensions_mm,
      price_cents: facts.product.price_cents,
      features: facts.features,
      documents: facts.documents,
      images: facts.images,
    },
    content,
    drifted: Boolean(content) && content.source_fingerprint !== facts.product.source_fingerprint,
  });
});

// PUT /api/product-content/:sku — write our copy.
router.put("/:sku", requireAuth, (req, res) => {
  const { sku } = req.params;
  const facts = feedFactsFor(sku);
  if (!facts) return res.status(404).json({ error: "Producto no encontrado" });

  const status = req.body.status === "owned" ? "owned" : "enriched";
  const display_name = (req.body.display_name || "").trim() || null;
  const description_md = (req.body.description_md || "").trim() || null;
  const tier = (req.body.tier || "").trim() || null;

  if (display_name && display_name.length > MAX_DISPLAY_NAME) {
    return res.status(400).json({ error: `El título supera ${MAX_DISPLAY_NAME} caracteres` });
  }
  if (description_md && description_md.length > MAX_DESCRIPTION) {
    return res.status(400).json({ error: `El cuerpo supera ${MAX_DESCRIPTION} caracteres` });
  }

  let evidence = null;
  if (req.body.evidence !== undefined) {
    if (!Array.isArray(req.body.evidence)) {
      return res.status(400).json({ error: "evidence debe ser una lista de URLs" });
    }
    const urls = req.body.evidence.slice(0, MAX_EVIDENCE).map(String);
    if (urls.some((u) => !/^https?:\/\//i.test(u))) {
      return res.status(400).json({ error: "Cada evidencia debe ser una URL http(s)" });
    }
    evidence = JSON.stringify(urls);
  }

  // Identifiers are copied from the feed, never accepted from the caller.
  // They are what would let a future migration re-match this copy to the same
  // physical product, so a wrong one is worse than none — and an agent has no
  // business asserting a barcode we already know.
  const payload = {
    sku,
    display_name,
    description_md,
    status,
    tier,
    evidence,
    gtin: facts.product.gtin,
    mpn: facts.product.mpn,
    // Snapshotted here, server-side, at the moment of writing. If the caller
    // supplied it, an agent could pin a stale value and permanently blind the
    // drift check on that sheet.
    source_fingerprint: facts.product.source_fingerprint,
  };

  if (status === "owned") {
    const blockers = ownershipBlockers(sku, payload);
    if (blockers.length > 0) {
      return res.status(422).json({
        error: "La ficha aún no cumple los requisitos para publicarse",
        blockers,
      });
    }
  }

  db.prepare(
    `INSERT INTO product_content (sku, display_name, description_md, status, tier, evidence, gtin, mpn, source_fingerprint)
     VALUES (@sku, @display_name, @description_md, @status, @tier, @evidence, @gtin, @mpn, @source_fingerprint)
     ON CONFLICT(sku) DO UPDATE SET
       display_name = excluded.display_name,
       description_md = excluded.description_md,
       status = excluded.status,
       tier = excluded.tier,
       evidence = excluded.evidence,
       gtin = excluded.gtin,
       mpn = excluded.mpn,
       source_fingerprint = excluded.source_fingerprint,
       updated_at = datetime('now')`,
  ).run(payload);

  // Only a published sheet changes what a visitor sees, so only that is worth
  // the cost of regenerating 15,000 pages.
  if (status === "owned") scheduleRebuild();

  res.json({
    success: true,
    status,
    ...db.prepare("SELECT * FROM product_content WHERE sku = ?").get(sku),
  });
});

export default router;
