import db, { getConfig, setConfig } from "../../db/database.js";
import { scheduleRebuild } from "../../build/rebuild.js";
import { fetchViaSftp, fetchFromLocalDir, cleanupScratch } from "./client.js";
import { joinLiderpapelCatalog } from "./parse.js";

// Inserts new SKUs (seeding active = feed_active) and refreshes every
// feed-owned column on existing SKUs — but never touches `active`, so an
// admin's manual on/off toggle in the panel survives future syncs.
//
// `slug` is likewise never updated. It derives from the feed title, so
// refreshing it meant that any wording change Liderpapel made to INT_VTE
// silently moved the product's public URL and left the old one 404ing —
// invisible while these pages had no content, a recurring loss of indexed
// URLs now that they do. The slug is set once, on insert, and pinned from
// then on; `name` keeps tracking the feed underneath it.
//
// Resets feed_active to 0 for everything first, inside the same transaction,
// then the upsert below sets it back to 1 for every SKU actually present in
// this sync — so a SKU that drops out of the feed entirely (discontinued,
// no longer VAL) ends up feed_active = 0 without needing a NOT-IN-list over
// thousands of SKUs. Consumers (site/_data/products.js, src/api/knowledge.js)
// filter on `active = 1 AND feed_active = 1`, so a stale product stops being
// sold even though `active` — the admin's own toggle — is left untouched.
//
// `slug` is likewise never updated. It derives from the feed title, so
// refreshing it meant that any wording change Liderpapel made to INT_VTE
// silently moved the product's public URL and left the old one 404ing —
// invisible while these pages had no content, a recurring loss of indexed
// URLs once they do. The slug is set once, on insert, and pinned from then
// on; `name` keeps tracking the feed underneath it.
//
// `product_content` is not touched here at all, by design. That table holds the
// copy we own once a sheet is better than the feed's, and the daily sync being
// unable to reach it is the entire mechanism — see the table comment in
// database.js. What the sync does supply is `source_fingerprint`, the hash that
// lets an owned sheet notice the facts underneath it moved.
//
// Exported for sync.test.js: the alternative is driving runLiderpapelSync,
// which pulls in the sFTP client and kicks off a real Eleventy rebuild.
export function upsertProducts(products) {
  const upsert = db.transaction((entries) => {
    db.prepare("UPDATE products SET feed_active = 0 WHERE feed_active = 1").run();

    const stmt = db.prepare(`
      INSERT INTO products (sku, slug, name, description, category, search_text, price_cents, stock_qty, image_url, gtin, mpn, brand, weight_grams, dimensions_mm, source_fingerprint, feed_active, active, last_synced_at)
      VALUES (@sku, @slug, @name, @description, @category, @search_text, @price_cents, @stock_qty, @image_url, @gtin, @mpn, @brand, @weight_grams, @dimensions_mm, @source_fingerprint, @feed_active, @feed_active, datetime('now'))
      ON CONFLICT(sku) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        category = excluded.category,
        search_text = excluded.search_text,
        price_cents = excluded.price_cents,
        stock_qty = excluded.stock_qty,
        image_url = excluded.image_url,
        gtin = excluded.gtin,
        mpn = excluded.mpn,
        brand = excluded.brand,
        weight_grams = excluded.weight_grams,
        dimensions_mm = excluded.dimensions_mm,
        source_fingerprint = excluded.source_fingerprint,
        feed_active = excluded.feed_active,
        last_synced_at = excluded.last_synced_at,
        updated_at = datetime('now')
    `);

    // Child rows are replaced per SKU rather than truncated up front: a
    // product that drops out of this sync keeps its old specs and documents
    // alongside its now feed_active = 0 row, which is the same treatment the
    // product row itself gets.
    const clear = {
      features: db.prepare("DELETE FROM product_features WHERE sku = ?"),
      images: db.prepare("DELETE FROM product_images WHERE sku = ?"),
      documents: db.prepare("DELETE FROM product_documents WHERE sku = ?"),
    };
    const insert = {
      features: db.prepare(
        "INSERT INTO product_features (sku, name, value, position) VALUES (?, ?, ?, ?)",
      ),
      images: db.prepare(
        "INSERT INTO product_images (sku, url, position) VALUES (?, ?, ?)",
      ),
      documents: db.prepare(
        "INSERT INTO product_documents (sku, url, label, position) VALUES (?, ?, ?, ?)",
      ),
    };

    for (const { row, features, images, documents } of entries) {
      stmt.run(row);

      clear.features.run(row.sku);
      features.forEach((f, i) => insert.features.run(row.sku, f.name, f.value, i));

      clear.images.run(row.sku);
      images.forEach((url, i) => insert.images.run(row.sku, url, i));

      clear.documents.run(row.sku);
      documents.forEach((d, i) =>
        insert.documents.run(row.sku, d.url, d.label, i),
      );
    }
  });
  upsert(products);
}

export async function runLiderpapelSync() {
  setConfig("liderpapel_last_sync_status", "running");
  try {
    const mode = process.env.LIDERPAPEL_SYNC_MODE || getConfig("liderpapel_sync_mode") || "sftp";

    let paths;
    if (mode === "local") {
      const dir = process.env.LIDERPAPEL_LOCAL_DIR || getConfig("liderpapel_local_dir");
      if (!dir) throw new Error("LIDERPAPEL_LOCAL_DIR no configurado para el modo local");
      paths = fetchFromLocalDir(dir);
    } else {
      const host = process.env.LIDERPAPEL_SFTP_HOST || getConfig("liderpapel_sftp_host");
      const port = Number(process.env.LIDERPAPEL_SFTP_PORT || getConfig("liderpapel_sftp_port") || 22);
      const username = process.env.LIDERPAPEL_SFTP_USER || getConfig("liderpapel_sftp_user");
      const password = process.env.LIDERPAPEL_SFTP_PASS || getConfig("liderpapel_sftp_pass");
      if (!host || !username || !password) {
        throw new Error("Credenciales sFTP de Liderpapel incompletas");
      }
      paths = await fetchViaSftp({ host, port, username, password });
    }

    const supplierCode =
      process.env.LIDERPAPEL_SUPPLIER_CODE || getConfig("liderpapel_supplier_code");
    if (!supplierCode) {
      throw new Error("Código de proveedor de Liderpapel no configurado");
    }
    // Explicit null/empty check, not `||` — a deployment can legitimately
    // set margin to "0" (sell at purchase price), and Number("0") is falsy.
    const rawMargin = getConfig("liderpapel_margin_pct");
    const marginPct = (rawMargin != null && rawMargin !== "" ? Number(rawMargin) : 40) / 100;
    const products = joinLiderpapelCatalog(paths, { supplierCode, marginPct });
    if (products.size === 0) {
      // Almost certainly an upstream feed/parse problem, not reality — never
      // let an empty sync wipe out feed_active on the whole catalog.
      throw new Error("El feed de Liderpapel no devolvió ningún producto VAL");
    }
    upsertProducts(Array.from(products.values()));

    setConfig("liderpapel_last_sync_status", "ok");
    setConfig("liderpapel_last_sync_at", new Date().toISOString());
    setConfig("liderpapel_last_sync_count", String(products.size));
    return { success: true, count: products.size };
  } catch (err) {
    setConfig("liderpapel_last_sync_status", "error");
    setConfig("liderpapel_last_sync_message", err.message);
    throw err;
  } finally {
    cleanupScratch();
    scheduleRebuild();
  }
}
