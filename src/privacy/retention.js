import cron from "node-cron";
import db from "../db/database.js";
import {
  CONTACT_RETENTION_MONTHS,
  ORDER_RETENTION_YEARS,
} from "./retention-periods.js";

// Deletes personal data once its period (retention-periods.js) is over. Before
// this module nothing was ever deleted, so the privacy policy's "el tiempo
// necesario" was a promise with no mechanism behind it.

// Daily, off-peak, after the uploads sweep (04:30).
const RETENTION_SCHEDULE = "45 4 * * *";

// created_at is SQLite datetime('now') text (UTC, "YYYY-MM-DD HH:MM:SS"), so
// the cutoff is computed by SQLite too and compared as datetimes.
const purge = db.transaction(() => {
  const contact = db
    .prepare(
      "DELETE FROM contact_messages WHERE datetime(created_at) < datetime('now', ?)",
    )
    .run(`-${CONTACT_RETENTION_MONTHS} months`).changes;
  const orderCutoff = `-${ORDER_RETENTION_YEARS} years`;
  db.prepare(
    "DELETE FROM reservation_items WHERE reservation_id IN (SELECT id FROM reservations WHERE datetime(created_at) < datetime('now', ?))",
  ).run(orderCutoff);
  const orders = db
    .prepare(
      "DELETE FROM reservations WHERE datetime(created_at) < datetime('now', ?)",
    )
    .run(orderCutoff).changes;
  return { contact, orders };
});

export function purgeExpiredPersonalData() {
  const counts = purge();
  if (counts.contact || counts.orders) {
    console.log(
      `retention: borrados ${counts.contact} mensajes de contacto y ${counts.orders} pedidos fuera de plazo`,
    );
  }
  return counts;
}

let started = false;

export function startRetentionScheduler() {
  if (started) return;
  started = true;
  const run = (when) => {
    try {
      purgeExpiredPersonalData();
    } catch (err) {
      console.error(`retention (${when}):`, err.message);
    }
  };
  run("inicio");
  cron.schedule(RETENTION_SCHEDULE, () => run("programado"));
}
