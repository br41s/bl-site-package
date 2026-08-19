import db, { getConfig, setConfig } from "../../db/database.js";
import { scheduleRebuild } from "../../build/rebuild.js";
import { fetchViaSftp, fetchFromLocalDir, cleanupScratch } from "./client.js";
import { joinLiderpapelCatalog } from "./parse.js";

// Inserts new SKUs (seeding active = feed_active) and refreshes every
// feed-owned column on existing SKUs — but never touches `active`, so an
// admin's manual on/off toggle in the panel survives future syncs.
//
// Resets feed_active to 0 for everything first, inside the same transaction,
// then the upsert below sets it back to 1 for every SKU actually present in
// this sync — so a SKU that drops out of the feed entirely (discontinued,
// no longer VAL) ends up feed_active = 0 without needing a NOT-IN-list over
// thousands of SKUs. Consumers (site/_data/products.js, src/api/knowledge.js)
// filter on `active = 1 AND feed_active = 1`, so a stale product stops being
// sold even though `active` — the admin's own toggle — is left untouched.
function upsertProducts(products) {
  const upsert = db.transaction((rows) => {
    db.prepare("UPDATE products SET feed_active = 0 WHERE feed_active = 1").run();

    const stmt = db.prepare(`
      INSERT INTO products (sku, slug, name, description, category, search_text, price_cents, stock_qty, image_url, feed_active, active, last_synced_at)
      VALUES (@sku, @slug, @name, @description, @category, @search_text, @price_cents, @stock_qty, @image_url, @feed_active, @feed_active, datetime('now'))
      ON CONFLICT(sku) DO UPDATE SET
        slug = excluded.slug,
        name = excluded.name,
        description = excluded.description,
        category = excluded.category,
        search_text = excluded.search_text,
        price_cents = excluded.price_cents,
        stock_qty = excluded.stock_qty,
        image_url = excluded.image_url,
        feed_active = excluded.feed_active,
        last_synced_at = excluded.last_synced_at,
        updated_at = datetime('now')
    `);
    for (const row of rows) stmt.run(row);
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
