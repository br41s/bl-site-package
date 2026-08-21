import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// database.js resolves DB_PATH at import time and refuses to start if it lands
// in a served directory, so point it at a throwaway dir before anything that
// imports it is loaded.
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "bl-site-content-api-")), "app.db");
process.env.JWT_SECRET = "test-secret-for-product-content";
// Publishing schedules a real Eleventy build 400ms later (src/build/rebuild.js).
// Left on, this suite would kick off a dozen full builds of the catalogue.
process.env.BL_SITE_DISABLE_REBUILD = "1";

const express = (await import("express")).default;
const jwt = (await import("jsonwebtoken")).default;
const db = (await import("../db/database.js")).default;
const router = (await import("./product-content.js")).default;

const TOKEN = jwt.sign({ role: "admin" }, process.env.JWT_SECRET);
const FEED_FP = "feedfingerprint00000000000000000";

let server;
let baseUrl;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/product-content", router);
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

function api(path, options = {}) {
  return fetch(`${baseUrl}/api/product-content${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.auth === false ? {} : { Authorization: `Bearer ${TOKEN}` }),
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
}

function seedProduct(sku, overrides = {}) {
  db.prepare(
    `INSERT INTO products (sku, slug, name, description, category, search_text,
       price_cents, stock_qty, gtin, mpn, brand, source_fingerprint, feed_active, active)
     VALUES (@sku, @slug, @name, '', '', '', @price_cents, @stock_qty, @gtin, @mpn, 'Fellowes',
       @source_fingerprint, 1, 1)`,
  ).run({
    sku,
    slug: `${sku}-producto`,
    name: `Producto ${sku}`,
    price_cents: 10000,
    stock_qty: 5,
    gtin: "50043859629256",
    mpn: "4691001",
    source_fingerprint: FEED_FP,
    ...overrides,
  });
  db.prepare(
    "INSERT INTO product_features (sku, name, value, position) VALUES (?, 'Marca', 'Fellowes', 0)",
  ).run(sku);
}

const VALID = {
  display_name: "Destructora Fellowes 99Ci — nivel P-4",
  description_md: "Cuerpo propio, escrito a partir de los datos del feed.",
  status: "owned",
};

beforeEach(() => {
  db.exec(
    "DELETE FROM products; DELETE FROM product_content; DELETE FROM product_features; DELETE FROM product_documents; DELETE FROM product_images;",
  );
});

describe("product content API — access", () => {
  test("refuses unauthenticated reads", async () => {
    assert.equal((await api("/queue", { auth: false })).status, 401);
  });

  test("refuses unauthenticated writes", async () => {
    seedProduct("100");
    const res = await api("/100", { method: "PUT", body: VALID, auth: false });
    assert.equal(res.status, 401);
  });

  test("404s on a product that is not for sale", async () => {
    assert.equal((await api("/does-not-exist")).status, 404);
  });
});

describe("product content API — what the writer is given", () => {
  test("hands over the feed's facts for the sheet", async () => {
    seedProduct("100");
    db.prepare(
      "INSERT INTO product_documents (sku, url, label, position) VALUES ('100','https://cdn.test/a.pdf','a.pdf',0)",
    ).run();

    const body = await (await api("/100")).json();
    assert.equal(body.feed.gtin, "50043859629256");
    assert.equal(body.feed.mpn, "4691001");
    assert.deepEqual(body.feed.features, [{ name: "Marca", value: "Fellowes" }]);
    assert.equal(body.feed.documents.length, 1);
    assert.equal(body.content, null);
  });
});

describe("product content API — publishing gate", () => {
  test("saves a draft without meeting the checklist", async () => {
    seedProduct("100");
    const res = await api("/100", {
      method: "PUT",
      body: { description_md: "Medio escrito.", status: "enriched" },
    });

    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, "enriched");
  });

  test("refuses to publish without a title, and says why", async () => {
    seedProduct("100");
    const res = await api("/100", {
      method: "PUT",
      body: { description_md: "Cuerpo.", status: "owned" },
    });

    assert.equal(res.status, 422);
    const body = await res.json();
    assert.ok(body.blockers.some((b) => b.includes("display_name")));
  });

  test("refuses to publish without a body", async () => {
    seedProduct("100");
    const res = await api("/100", {
      method: "PUT",
      body: { display_name: "Un título", status: "owned" },
    });

    assert.equal(res.status, 422);
    assert.ok((await res.json()).blockers.some((b) => b.includes("description_md")));
  });

  test("refuses to publish a product the feed gave no specifications", async () => {
    seedProduct("100");
    db.prepare("DELETE FROM product_features WHERE sku = '100'").run();

    const res = await api("/100", { method: "PUT", body: VALID });
    assert.equal(res.status, 422);
    assert.ok((await res.json()).blockers.some((b) => b.includes("características")));
  });

  test("publishes once the checklist is met", async () => {
    seedProduct("100");
    const res = await api("/100", { method: "PUT", body: VALID });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "owned");
    assert.equal(body.display_name, VALID.display_name);
  });

  test("publishes a product that has no barcode at all", async () => {
    // ~1,100 of 14,487 real products carry no EAN_UNIDAD. Requiring one would
    // strand them unenriched forever.
    seedProduct("100", { gtin: null, mpn: null });

    assert.equal((await api("/100", { method: "PUT", body: VALID })).status, 200);
  });
});

describe("product content API — what the caller is not allowed to assert", () => {
  test("takes the fingerprint from the feed, never from the caller", async () => {
    // The whole drift mechanism hangs on this. A caller that could pin its own
    // fingerprint could pin a stale one and blind the check on that sheet
    // permanently — the sheet would then never be flagged again, however far
    // the facts underneath it moved.
    seedProduct("100");
    await api("/100", {
      method: "PUT",
      body: { ...VALID, source_fingerprint: "fingerprint-inventado-por-el-agente" },
    });

    const row = db.prepare("SELECT * FROM product_content WHERE sku = '100'").get();
    assert.equal(row.source_fingerprint, FEED_FP);
  });

  test("takes the barcode and reference from the feed, never from the caller", async () => {
    seedProduct("100");
    await api("/100", {
      method: "PUT",
      body: { ...VALID, gtin: "0000000000000", mpn: "INVENTADA" },
    });

    const row = db.prepare("SELECT * FROM product_content WHERE sku = '100'").get();
    assert.equal(row.gtin, "50043859629256");
    assert.equal(row.mpn, "4691001");
  });

  test("rejects evidence that is not a list of http(s) URLs", async () => {
    seedProduct("100");

    const notArray = await api("/100", {
      method: "PUT",
      body: { ...VALID, evidence: "https://example.com" },
    });
    assert.equal(notArray.status, 400);

    const notUrl = await api("/100", {
      method: "PUT",
      body: { ...VALID, evidence: ["javascript:alert(1)"] },
    });
    assert.equal(notUrl.status, 400);
  });

  test("stores evidence URLs when they are well formed", async () => {
    seedProduct("100");
    await api("/100", {
      method: "PUT",
      body: { ...VALID, evidence: ["https://fellowes.com/99ci"] },
    });

    const row = db.prepare("SELECT * FROM product_content WHERE sku = '100'").get();
    assert.deepEqual(JSON.parse(row.evidence), ["https://fellowes.com/99ci"]);
  });
});

describe("product content API — a write only changes what it carries", () => {
  // Found by hermes-auditor on hermes-sandbox#181. The reported shape was the
  // tool sending display_name: null; the underlying fault was worse — the
  // server could not tell an absent key from an explicit null, so simply
  // omitting the field cleared it too. A caller correcting a body would have
  // wiped the title off a published product page, with a 200 and no log line.

  test("correcting the body leaves the title alone", async () => {
    seedProduct("100");
    await api("/100", { method: "PUT", body: VALID });

    await api("/100", { method: "PUT", body: { description_md: "Cuerpo corregido." } });

    const row = db.prepare("SELECT * FROM product_content WHERE sku = '100'").get();
    assert.equal(row.display_name, VALID.display_name);
    assert.equal(row.description_md, "Cuerpo corregido.");
  });

  test("correcting the title leaves the body alone", async () => {
    seedProduct("100");
    await api("/100", { method: "PUT", body: VALID });

    await api("/100", { method: "PUT", body: { display_name: "Título corregido" } });

    const row = db.prepare("SELECT * FROM product_content WHERE sku = '100'").get();
    assert.equal(row.display_name, "Título corregido");
    assert.equal(row.description_md, VALID.description_md);
  });

  test("a partial write does not quietly unpublish the sheet", async () => {
    // status defaulted to 'enriched' when absent, so a body-only correction
    // took a live product page down as a side effect.
    seedProduct("100");
    await api("/100", { method: "PUT", body: VALID });

    await api("/100", { method: "PUT", body: { description_md: "Cuerpo corregido." } });

    assert.equal(
      db.prepare("SELECT status FROM product_content WHERE sku = '100'").get().status,
      "owned",
    );
  });

  test("an explicit empty value still clears the field", async () => {
    // Absent means leave alone; present-but-empty is how a field is reset on
    // purpose. Losing that would make a wrong title unfixable.
    seedProduct("100");
    await api("/100", { method: "PUT", body: { ...VALID, status: "enriched" } });

    await api("/100", { method: "PUT", body: { display_name: "" } });

    assert.equal(
      db.prepare("SELECT display_name FROM product_content WHERE sku = '100'").get().display_name,
      null,
    );
  });

  test("but a published sheet cannot be left without a title", async () => {
    // The publishing gate and partial writes meet here, and the gate wins:
    // clearing the title of a live sheet is refused rather than applied, so a
    // product page can never end up published with no name.
    seedProduct("100");
    await api("/100", { method: "PUT", body: VALID });

    const res = await api("/100", { method: "PUT", body: { display_name: "" } });

    assert.equal(res.status, 422);
    assert.equal(
      db.prepare("SELECT display_name FROM product_content WHERE sku = '100'").get().display_name,
      VALID.display_name,
      "the refusal leaves the live sheet untouched",
    );
  });

  test("evidence survives a write that does not mention it", async () => {
    seedProduct("100");
    await api("/100", {
      method: "PUT",
      body: { ...VALID, evidence: ["https://fellowes.com/99ci"] },
    });

    await api("/100", { method: "PUT", body: { description_md: "Otro cuerpo." } });

    const row = db.prepare("SELECT evidence FROM product_content WHERE sku = '100'").get();
    assert.deepEqual(JSON.parse(row.evidence), ["https://fellowes.com/99ci"]);
  });

  test("a first write still starts from nothing, not from a ghost", async () => {
    seedProduct("100");
    await api("/100", { method: "PUT", body: { description_md: "Solo cuerpo." } });

    const row = db.prepare("SELECT * FROM product_content WHERE sku = '100'").get();
    assert.equal(row.display_name, null);
    assert.equal(row.status, "enriched");
  });
});

describe("product content API — clearing a review", () => {
  async function publishThenDrift() {
    seedProduct("100");
    await api("/100", { method: "PUT", body: VALID });
    db.prepare("UPDATE products SET source_fingerprint = 'movido' WHERE sku = '100'").run();
  }

  test("acknowledging takes the sheet out of the queue", async () => {
    await publishThenDrift();

    const res = await api("/100/acknowledge", { method: "POST" });
    assert.equal(res.status, 200);

    const { review, totals } = await (await api("/queue")).json();
    assert.deepEqual(review, []);
    assert.equal(totals.drifted, 0);
  });

  test("acknowledging does not touch a word of the copy", async () => {
    await publishThenDrift();
    await api("/100/acknowledge", { method: "POST" });

    const row = db.prepare("SELECT * FROM product_content WHERE sku = '100'").get();
    assert.equal(row.display_name, VALID.display_name);
    assert.equal(row.description_md, VALID.description_md);
    assert.equal(row.status, "owned");
  });

  test("a sheet flagged again after a second change", async () => {
    // Acknowledging settles the change it was shown, not every future one.
    await publishThenDrift();
    await api("/100/acknowledge", { method: "POST" });
    db.prepare("UPDATE products SET source_fingerprint = 'movido-otra-vez' WHERE sku = '100'").run();

    const { totals } = await (await api("/queue")).json();
    assert.equal(totals.drifted, 1);
  });

  test("unpublishing hands the page back to the feed but keeps our work", async () => {
    seedProduct("100");
    await api("/100", { method: "PUT", body: VALID });

    const res = await api("/100/unpublish", { method: "POST" });
    assert.equal(res.status, 200);

    const row = db.prepare("SELECT * FROM product_content WHERE sku = '100'").get();
    assert.equal(row.status, "enriched");
    assert.equal(row.display_name, VALID.display_name, "the copy is kept, not discarded");
  });

  test("neither action invents a published sheet where there is none", async () => {
    seedProduct("100");

    assert.equal((await api("/100/acknowledge", { method: "POST" })).status, 404);
    assert.equal((await api("/100/unpublish", { method: "POST" })).status, 404);
  });

  test("both actions need authentication", async () => {
    seedProduct("100");
    await api("/100", { method: "PUT", body: VALID });

    assert.equal((await api("/100/acknowledge", { method: "POST", auth: false })).status, 401);
    assert.equal((await api("/100/unpublish", { method: "POST", auth: false })).status, 401);
  });
});

describe("product content API — passing over an unwritable product", () => {
  // Some products carry nothing to write a sheet from: the feed knows a brand
  // and nothing else. An agent that correctly declines to invent
  // specifications needs somewhere to record that, or the same product leads
  // the batch every morning and the queue silently stops making progress.
  const SKIP = { status: "skipped", skip_reason: "el feed solo trae la marca" };

  test("a skip needs no title or body", async () => {
    seedProduct("100");
    const res = await api("/100", { method: "PUT", body: SKIP });

    assert.equal(res.status, 200);
    const row = db.prepare("SELECT * FROM product_content WHERE sku = '100'").get();
    assert.equal(row.status, "skipped");
    assert.equal(row.skip_reason, "el feed solo trae la marca");
  });

  test("a skipped product leaves the queue", async () => {
    seedProduct("100");
    await api("/100", { method: "PUT", body: SKIP });

    const { pending } = await (await api("/queue")).json();
    assert.deepEqual(pending, []);
  });

  test("it comes back the moment the feed gives us something new", async () => {
    // The same fingerprint that detects drift under a published sheet decides
    // when a skip has expired — no timer, no second mechanism.
    seedProduct("100");
    await api("/100", { method: "PUT", body: SKIP });
    db.prepare("UPDATE products SET source_fingerprint = 'el feed cambió' WHERE sku = '100'").run();

    const { pending } = await (await api("/queue")).json();
    assert.deepEqual(pending.map((p) => p.sku), ["100"]);
  });

  test("a skip is not a publication", async () => {
    seedProduct("100");
    await api("/100", { method: "PUT", body: SKIP });

    const { totals } = await (await api("/queue")).json();
    assert.equal(totals.owned, 0);
  });

  test("skip_reason is dropped when the sheet is later written", async () => {
    seedProduct("100");
    await api("/100", { method: "PUT", body: SKIP });
    await api("/100", { method: "PUT", body: VALID });

    const row = db.prepare("SELECT * FROM product_content WHERE sku = '100'").get();
    assert.equal(row.status, "owned");
    assert.equal(row.skip_reason, null, "a written sheet carries no skip reason");
  });

  test("an unknown status is treated as a draft, never as published", async () => {
    seedProduct("100");
    await api("/100", { method: "PUT", body: { ...VALID, status: "publicadísima" } });

    const row = db.prepare("SELECT * FROM product_content WHERE sku = '100'").get();
    assert.equal(row.status, "enriched");
  });
});

describe("product content API — queue ordering", () => {
  test("products nobody has touched come before ones already seen", async () => {
    // A draft or an expired skip is work in progress; unwritten products are
    // coverage. Ordering by price alone would let a handful of difficult
    // expensive items monopolise every batch.
    seedProduct("cheap-untouched", { price_cents: 100 });
    seedProduct("dear-skipped", { price_cents: 90000 });
    await api("/dear-skipped", {
      method: "PUT",
      body: { status: "skipped", skip_reason: "sin datos" },
    });
    db.prepare("UPDATE products SET source_fingerprint = 'nuevo' WHERE sku = 'dear-skipped'").run();

    const { pending } = await (await api("/queue")).json();
    assert.deepEqual(pending.map((p) => p.sku), ["cheap-untouched", "dear-skipped"]);
  });
});

describe("product content API — the work queue", () => {
  test("offers unwritten products, dearest first", async () => {
    seedProduct("cheap", { price_cents: 100 });
    seedProduct("dear", { price_cents: 90000 });

    const { pending } = await (await api("/queue")).json();
    assert.deepEqual(
      pending.map((p) => p.sku),
      ["dear", "cheap"],
    );
  });

  test("skips what is already published", async () => {
    seedProduct("100");
    await api("/100", { method: "PUT", body: VALID });

    const { pending } = await (await api("/queue")).json();
    assert.deepEqual(pending, []);
  });

  test("keeps offering a draft, since it is not finished", async () => {
    seedProduct("100");
    await api("/100", { method: "PUT", body: { description_md: "A medias.", status: "enriched" } });

    const { pending } = await (await api("/queue")).json();
    assert.deepEqual(
      pending.map((p) => p.sku),
      ["100"],
    );
  });

  test("skips what cannot be sold", async () => {
    seedProduct("100", { stock_qty: 0 });

    const { pending } = await (await api("/queue")).json();
    assert.deepEqual(pending, []);
  });

  test("lists a published sheet whose facts have since moved", async () => {
    seedProduct("100");
    await api("/100", { method: "PUT", body: VALID });
    db.prepare("UPDATE products SET source_fingerprint = 'otro' WHERE sku = '100'").run();

    const { review, totals } = await (await api("/queue")).json();
    assert.deepEqual(
      review.map((r) => r.sku),
      ["100"],
    );
    assert.equal(totals.owned, 1);
    assert.equal(totals.drifted, 1);
  });

  test("does not call a published sheet drifted while nothing moved", async () => {
    seedProduct("100");
    await api("/100", { method: "PUT", body: VALID });

    const { review, totals } = await (await api("/queue")).json();
    assert.deepEqual(review, []);
    assert.equal(totals.drifted, 0);
  });

  test("caps how much work it hands out at once", async () => {
    for (let i = 0; i < 5; i += 1) seedProduct(`sku-${i}`, { price_cents: 1000 + i });

    const { pending } = await (await api("/queue?limit=2")).json();
    assert.equal(pending.length, 2);
  });
});
