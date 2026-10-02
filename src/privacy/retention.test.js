import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(
  mkdtempSync(join(tmpdir(), "bl-site-retention-")),
  "app.db",
);

const db = (await import("../db/database.js")).default;
const { purgeExpiredPersonalData } = await import("./retention.js");

after(() => db.close());

beforeEach(() => {
  db.prepare("DELETE FROM contact_messages").run();
  db.prepare("DELETE FROM reservation_items").run();
  db.prepare("DELETE FROM reservations").run();
});

const ago = (modifier) =>
  db.prepare("SELECT datetime('now', ?) AS t").get(modifier).t;

function message(createdAt) {
  db.prepare(
    "INSERT INTO contact_messages (name, email, message, created_at) VALUES ('Ana', 'ana@example.com', 'Hola', ?)",
  ).run(createdAt);
}

function order(createdAt) {
  const { lastInsertRowid } = db
    .prepare(
      "INSERT INTO reservations (customer_name, customer_email, created_at) VALUES ('Ana', 'ana@example.com', ?)",
    )
    .run(createdAt);
  db.prepare(
    "INSERT INTO reservation_items (reservation_id, sku, product_name, unit_price_cents, quantity) VALUES (?, 'A1', 'Folios', 500, 1)",
  ).run(lastInsertRowid);
  return lastInsertRowid;
}

test("contact messages older than two years go, newer ones stay", () => {
  message(ago("-25 months"));
  message(ago("-23 months"));
  assert.deepEqual(purgeExpiredPersonalData(), { contact: 1, orders: 0 });
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM contact_messages").get().n,
    1,
  );
});

test("orders older than six years go with their lines; newer ones are untouched", () => {
  const old = order(ago("-2200 days")); // a little over six years
  const recent = order(ago("-5 years"));
  assert.deepEqual(purgeExpiredPersonalData(), { contact: 0, orders: 1 });
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM reservation_items WHERE reservation_id = ?",
      )
      .get(old).n,
    0,
  );
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM reservation_items WHERE reservation_id = ?",
      )
      .get(recent).n,
    1,
  );
});

test("nothing to purge is a no-op", () => {
  message(ago("-1 day"));
  assert.deepEqual(purgeExpiredPersonalData(), { contact: 0, orders: 0 });
});
