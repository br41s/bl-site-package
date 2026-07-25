import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, sep } from "node:path";
import { scheduleRebuild } from "../build/rebuild.js";

// Config keys exposed to the public site (GET /api/site/config and the
// Eleventy build-time data file, site/_data/site.js, both read this list).
export const PUBLIC_CONFIG_KEYS = [
  "company_name",
  "sector",
  "site_url",
  "page_index_title",
  "page_index_subtitle",
  "page_index_desc",
  "page_index_body",
  "page_index_image",
  "page_index_image_alt",
  "page_quienes_title",
  "page_quienes_subtitle",
  "page_quienes_desc",
  "page_quienes_image",
  "page_quienes_image_alt",
  "page_servicios_title",
  "page_servicios_subtitle",
  "page_servicios_desc",
  "page_servicios_image",
  "page_servicios_image_alt",
  "page_contacto_title",
  "page_contacto_subtitle",
  "page_contacto_desc",
  "page_contacto_image",
  "page_contacto_image_alt",
  "page_blog_title",
  "page_blog_subtitle",
  "logo_ext",
  "ai_model",
  "image_model",
  "whatsapp_number",
  "legal_name",
  "legal_id",
  "legal_address",
  "legal_email",
];

// Absolute, normalized path to the SQLite file. Default lives in ./data/app.db;
// on hosts where the web docroot is the app root (e.g. Plesk), point DB_PATH
// outside it (see RELEASE.md). The DB holds the panel password (plaintext), the
// JWT secret, the client's OpenRouter key and contact messages — it must never
// be reachable over HTTP.
export const DB_PATH = resolve(process.env.DB_PATH || "./data/app.db");

// Defense-in-depth: refuse to even OPEN the DB if it resolves inside a directory
// this app serves over HTTP. Runs before new Database() so a misconfigured
// deploy never writes the sensitive file into a served dir. We can't see an
// upstream nginx docroot from here (the Plesk leak was nginx serving the app
// root directly — fixed structurally by pointing the docroot at public/), but
// the unambiguously-wrong case — DB_PATH inside _site/, web/, public/ or
// data/uploads/ — is caught here. The Zeabur default (./data/app.db) is inside
// none of these, so this never false-positives on a correct deploy.
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const servedDirs = [
  join(appRoot, "_site"),
  join(appRoot, "web"),
  join(appRoot, "public"),
  join(appRoot, "data", "uploads"),
];
if (servedDirs.some((d) => DB_PATH === d || DB_PATH.startsWith(d + sep))) {
  console.error(
    `\n🚨 SECURITY: DB_PATH resolves inside a web-served directory:\n   ${DB_PATH}\n` +
      `   The database would be downloadable over HTTP. Set DB_PATH to a path\n` +
      `   OUTSIDE the web document root (see RELEASE.md). Refusing to start.\n`,
  );
  process.exit(1);
}

mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    content TEXT NOT NULL,
    excerpt TEXT,
    status TEXT DEFAULT 'draft',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS chat_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS contact_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sku TEXT UNIQUE NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    category TEXT,
    price_cents INTEGER NOT NULL DEFAULT 0,
    stock_qty INTEGER NOT NULL DEFAULT 0,
    image_url TEXT,
    feed_active INTEGER NOT NULL DEFAULT 1,
    active INTEGER NOT NULL DEFAULT 1,
    last_synced_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS reservations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_name TEXT NOT NULL,
    customer_email TEXT NOT NULL,
    customer_phone TEXT,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    total_cents INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS reservation_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reservation_id INTEGER NOT NULL,
    sku TEXT NOT NULL,
    product_name TEXT NOT NULL,
    unit_price_cents INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Additive migration for columns added after a client's DB was first
// created (CREATE TABLE IF NOT EXISTS above only applies to brand-new DBs).
function ensureColumn(table, column, definition) {
  const exists = db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((col) => col.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

ensureColumn("articles", "cta_url", "TEXT");
ensureColumn("articles", "cta_label", "TEXT");
// Cover image URL (points at an /uploads/*.webp produced by the upload
// endpoint) and its alt text. Additive like cta_* above — the base CREATE
// TABLE stays the original schema; every later field arrives via ensureColumn.
ensureColumn("articles", "image_url", "TEXT");
ensureColumn("articles", "image_alt", "TEXT");

// Seeds a config default without triggering scheduleRebuild() (unlike
// setConfig) and without overwriting a value an admin already set.
function seedConfigDefault(key, value) {
  db.prepare("INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)").run(key, value);
}

seedConfigDefault("liderpapel_sftp_host", "sftp.liderpapel.com");
seedConfigDefault("liderpapel_sftp_port", "22");
seedConfigDefault("liderpapel_sftp_user", "20603");

export function getConfig(key) {
  const row = db.prepare("SELECT value FROM config WHERE key = ?").get(key);
  return row ? row.value : null;
}

export function setConfig(key, value) {
  db.prepare(
    "INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))",
  ).run(key, value);
  scheduleRebuild();
}

export default db;
