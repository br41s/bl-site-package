import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import jwt from "jsonwebtoken";
import db, { getConfig, setConfig } from "../db/database.js";
import { requireAuth } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rateLimit.js";

// B2B area: business accounts that see trade prices once signed in.
//
// The public site is static HTML with the retail price baked in, so nothing
// here changes a built page. A signed-in account fetches its discounts from
// GET /me and web/cart.js rewrites the prices it shows. What the customer is
// actually charged is decided server-side, in POST /api/reservations, from the
// same resolveB2bAccount() + b2bUnitPriceCents() below — never from a price the
// browser sent.
//
// Discounts are per catalogue category (products.category, verbatim), with a
// general fallback for categories that have none. One tier for every account:
// that is the MVP, and per-account tiers can hang off b2b_accounts later.

const router = Router();

const COOKIE = "bl_b2b";
const SESSION_DAYS = 30;
const MIN_PASSWORD = 8;

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Demasiados intentos de acceso. Espera unos minutos.",
});

// ── Passwords ────────────────────────────────────────────────────────────────

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored || "").split(":");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(actual, expected);
}

// Compared against when the email matches no account, so an unknown email
// costs the same scrypt as a wrong password and response time cannot be used
// to find out which addresses have accounts.
const DUMMY_HASH = hashPassword(randomBytes(16).toString("hex"));

// ── Session ──────────────────────────────────────────────────────────────────
//
// NOT signed with jwt_secret itself. requireAuth, and the inline checks in
// src/api/products.js and src/api/blog.js, accept ANY token that verifies
// against jwt_secret as a panel admin — a B2B session signed with the same
// key would be a panel login for every trade customer. A key derived from it
// keeps the setup wizard as the only place a secret is created, and a B2B
// token can never verify as a panel one.
function sessionKey() {
  const secret = process.env.JWT_SECRET || getConfig("jwt_secret");
  return secret ? createHmac("sha256", secret).update("b2b-session-v1").digest("hex") : null;
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie || "").split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

// httpOnly so a script on the page (article bodies are customer HTML) can
// never read it; SameSite=Lax so another site cannot place a reservation with
// it. Secure only in production, where HSTS already assumes HTTPS — locally
// the cookie has to survive plain http://localhost.
function sessionCookie(value, maxAgeSeconds) {
  const parts = [
    `${COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

function clearSession(res) {
  res.setHeader("Set-Cookie", sessionCookie("", 0));
}

export function isB2bEnabled() {
  return getConfig("b2b_enabled") === "1";
}

// The signed-in, still-active B2B account behind this request, or null.
// Re-reads the account on every call: switching an account off in the panel
// takes effect on its next request, not when its 30-day cookie runs out.
export function resolveB2bAccount(req) {
  if (!isB2bEnabled()) return null;
  const token = readCookie(req, COOKIE);
  const key = sessionKey();
  if (!token || !key) return null;
  let payload;
  try {
    payload = jwt.verify(token, key);
  } catch {
    return null;
  }
  if (payload?.typ !== "b2b") return null;
  return (
    db.prepare("SELECT * FROM b2b_accounts WHERE id = ? AND active = 1").get(Number(payload.sub)) ||
    null
  );
}

// ── Pricing ──────────────────────────────────────────────────────────────────

// A percentage we are willing to price with. Every stored value is checked
// against this on READ, not only when the API writes it: parsePct guards the
// endpoint, but a row can arrive some other way (a migration, a hand edit),
// the REAL column happily stores text, and a NaN unit price does not produce
// a wrong total — it fails the NOT NULL insert inside an async handler and the
// customer's checkout hangs with no response at all.
function isValidPct(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value < 100;
}

export function getDefaultDiscountPct() {
  const value = Number(getConfig("b2b_default_discount_pct"));
  return isValidPct(value) ? value : 0;
}

// A malformed row is skipped, so its category falls back to the general
// discount — the same as having no row at all.
export function getCategoryDiscounts() {
  const map = {};
  for (const row of db.prepare("SELECT category, discount_pct FROM b2b_category_discounts").all()) {
    if (isValidPct(row.discount_pct)) map[row.category] = row.discount_pct;
  }
  return map;
}

// Same arithmetic as b2bPriceCents in web/cart.js — the two must agree to the
// cent, or the cart shows one total and the reservation records another. The
// guard is the last line of defence: an unusable discount means retail, never
// a NaN or negative price.
export function b2bPriceCents(priceCents, discountPct) {
  if (!isValidPct(discountPct)) return priceCents;
  return Math.round((priceCents * (100 - discountPct)) / 100);
}

export function discountFor(category, discounts, defaultPct) {
  return Object.prototype.hasOwnProperty.call(discounts, category || "")
    ? discounts[category || ""]
    : defaultPct;
}

// Pricing context for one request — load it once and price every line with it.
export function b2bPricing() {
  return { discounts: getCategoryDiscounts(), defaultPct: getDefaultDiscountPct() };
}

export function b2bUnitPriceCents(product, pricing) {
  return b2bPriceCents(
    product.price_cents,
    discountFor(product.category, pricing.discounts, pricing.defaultPct),
  );
}

// "12,5" from a Spanish keyboard is as valid as "12.5". Two decimals is more
// precision than any trade discount needs; 100 would make the product free.
function parsePct(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const n = Number(String(value).trim().replace(",", "."));
  if (String(value).trim() === "" || !Number.isFinite(n) || n < 0 || n >= 100) return null;
  return Math.round(n * 100) / 100;
}

function publicAccount(row) {
  if (!row) return null;
  const { password_hash, ...rest } = row;
  return rest;
}

// ── Customer endpoints ───────────────────────────────────────────────────────

// POST /api/b2b/login — { email, password }
router.post("/login", loginLimiter, (req, res) => {
  if (!isB2bEnabled()) {
    return res.status(404).json({ error: "El área de profesionales no está disponible." });
  }
  const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const password = typeof req.body.password === "string" ? req.body.password : "";
  if (!email || !password) {
    return res.status(400).json({ error: "Introduce tu email y tu contraseña." });
  }
  const key = sessionKey();
  if (!key) return res.status(503).json({ error: "Servidor no configurado" });

  const account = db.prepare("SELECT * FROM b2b_accounts WHERE email = ?").get(email);
  const passwordOk = verifyPassword(password, account ? account.password_hash : DUMMY_HASH);
  if (!account || !passwordOk) {
    return res.status(401).json({ error: "Email o contraseña incorrectos." });
  }
  // Checked only after the password, so the message can't be used to learn
  // which emails belong to a deactivated account.
  if (!account.active) {
    return res
      .status(403)
      .json({ error: "Tu cuenta de empresa está desactivada. Ponte en contacto con nosotros." });
  }

  db.prepare("UPDATE b2b_accounts SET last_login_at = datetime('now') WHERE id = ?").run(account.id);
  const token = jwt.sign({ sub: String(account.id), typ: "b2b" }, key, {
    expiresIn: `${SESSION_DAYS}d`,
  });
  res.setHeader("Set-Cookie", sessionCookie(token, SESSION_DAYS * 24 * 60 * 60));
  res.json({ success: true, account: { company_name: account.company_name } });
});

// POST /api/b2b/logout
router.post("/logout", (req, res) => {
  clearSession(res);
  res.json({ success: true });
});

// GET /api/b2b/me — the signed-in account and the discounts it gets. This is
// the only place the discount table leaves the server outside the panel.
router.get("/me", (req, res) => {
  const account = resolveB2bAccount(req);
  if (!account) {
    if (readCookie(req, COOKIE)) clearSession(res);
    return res.status(401).json({ error: "No has iniciado sesión." });
  }
  res.json({
    account: {
      company_name: account.company_name,
      contact_name: account.contact_name || "",
      email: account.email,
      phone: account.phone || "",
    },
    default_pct: getDefaultDiscountPct(),
    discounts: getCategoryDiscounts(),
  });
});

// ── Panel: settings ──────────────────────────────────────────────────────────

router.get("/settings", requireAuth, (req, res) => {
  res.json({ enabled: isB2bEnabled(), default_pct: getDefaultDiscountPct() });
});

// PUT /api/b2b/settings — { enabled?, default_pct? }; absent = leave alone.
router.put("/settings", requireAuth, (req, res) => {
  const { enabled, default_pct } = req.body;
  let pct;
  if (default_pct !== undefined) {
    pct = parsePct(default_pct === "" || default_pct === null ? 0 : default_pct);
    if (pct === null) {
      return res
        .status(400)
        .json({ error: "El descuento general debe ser un porcentaje entre 0 y 99,99." });
    }
  }
  // Written directly rather than through setConfig: the discount is not in any
  // built page, and setConfig would rebuild ~14,500 of them for nothing.
  if (pct !== undefined) {
    db.prepare(
      "INSERT OR REPLACE INTO config (key, value, updated_at) VALUES ('b2b_default_discount_pct', ?, datetime('now'))",
    ).run(String(pct));
  }
  // The flag IS in built pages (/profesionales, the catalogue banner), so this
  // one goes through setConfig and its rebuild — but only when it changes.
  if (enabled !== undefined) {
    const value = enabled === true || enabled === "1" || enabled === 1 ? "1" : "0";
    if (getConfig("b2b_enabled") !== value) setConfig("b2b_enabled", value);
  }
  res.json({ success: true, enabled: isB2bEnabled(), default_pct: getDefaultDiscountPct() });
});

// ── Panel: category discounts ────────────────────────────────────────────────

// GET /api/b2b/discounts — every category the live catalogue has, with its
// product count and its discount (null = uses the general one). Categories
// that have a discount but have since left the catalogue are listed too, with
// total 0, so the admin can see and clear them.
router.get("/discounts", requireAuth, (req, res) => {
  const counts = new Map();
  for (const { category } of db
    .prepare("SELECT category FROM products WHERE active = 1 AND feed_active = 1")
    .all()) {
    const label = category || "";
    if (!label.trim()) continue;
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  const discounts = getCategoryDiscounts();
  for (const category of Object.keys(discounts)) {
    if (!counts.has(category)) counts.set(category, 0);
  }
  const categories = Array.from(counts, ([category, total]) => ({
    category,
    total,
    discount_pct: Object.prototype.hasOwnProperty.call(discounts, category)
      ? discounts[category]
      : null,
  })).sort((a, b) => a.category.localeCompare(b.category, "es"));

  res.json({ default_pct: getDefaultDiscountPct(), categories });
});

// PUT /api/b2b/discounts — { discounts: { "<category>": pct | null | "" } }
// Partial: a category not in the body is left alone; null or "" removes its
// own discount so it falls back to the general one. All-or-nothing — one bad
// value rejects the whole request before anything is written.
router.put("/discounts", requireAuth, (req, res) => {
  const input = req.body.discounts;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return res.status(400).json({ error: "Formato no válido: se esperaba { discounts: { categoría: % } }" });
  }
  const upserts = [];
  const removals = [];
  for (const [rawCategory, value] of Object.entries(input)) {
    const category = rawCategory.trim();
    if (!category || category.length > 200) {
      return res.status(400).json({ error: "Nombre de categoría no válido." });
    }
    if (value === null || value === "") {
      removals.push(category);
      continue;
    }
    const pct = parsePct(value);
    if (pct === null) {
      return res.status(400).json({
        error: `Descuento no válido para «${category}»: usa un porcentaje entre 0 y 99,99.`,
      });
    }
    upserts.push([category, pct]);
  }

  const upsert = db.prepare(
    `INSERT INTO b2b_category_discounts (category, discount_pct, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(category) DO UPDATE SET discount_pct = excluded.discount_pct, updated_at = excluded.updated_at`,
  );
  const remove = db.prepare("DELETE FROM b2b_category_discounts WHERE category = ?");
  db.transaction(() => {
    for (const [category, pct] of upserts) upsert.run(category, pct);
    for (const category of removals) remove.run(category);
  })();

  res.json({ success: true, discounts: getCategoryDiscounts() });
});

// ── Panel: accounts ──────────────────────────────────────────────────────────

const ACCOUNT_TEXT_FIELDS = ["company_name", "tax_id", "contact_name", "email", "phone", "notes"];

function cleanAccountInput(body, { partial }) {
  const out = {};
  for (const field of ACCOUNT_TEXT_FIELDS) {
    if (body[field] === undefined) continue;
    if (body[field] !== null && typeof body[field] !== "string") {
      return { error: `Valor no válido para ${field}` };
    }
    out[field] = (body[field] || "").trim();
  }
  if (out.email !== undefined) {
    out.email = out.email.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) return { error: "Email no válido." };
  }
  if (out.company_name !== undefined && !out.company_name) {
    return { error: "El nombre de la empresa es obligatorio." };
  }
  if (!partial && (!out.company_name || !out.email)) {
    return { error: "El nombre de la empresa y el email son obligatorios." };
  }
  if (body.password !== undefined && body.password !== "") {
    if (typeof body.password !== "string" || body.password.length < MIN_PASSWORD) {
      return { error: `La contraseña debe tener al menos ${MIN_PASSWORD} caracteres.` };
    }
    out.password_hash = hashPassword(body.password);
  } else if (!partial) {
    return { error: `La contraseña debe tener al menos ${MIN_PASSWORD} caracteres.` };
  }
  if (body.active !== undefined) out.active = body.active ? 1 : 0;
  return { values: out };
}

function emailTaken(email, exceptId) {
  return Boolean(
    db.prepare("SELECT 1 FROM b2b_accounts WHERE email = ? AND id != ?").get(email, exceptId || 0),
  );
}

router.get("/accounts", requireAuth, (req, res) => {
  const accounts = db
    .prepare("SELECT * FROM b2b_accounts ORDER BY company_name COLLATE NOCASE, id")
    .all()
    .map(publicAccount);
  res.json({ accounts });
});

router.post("/accounts", requireAuth, (req, res) => {
  const { error, values } = cleanAccountInput(req.body, { partial: false });
  if (error) return res.status(400).json({ error });
  if (emailTaken(values.email)) {
    return res.status(409).json({ error: "Ya existe una cuenta con ese email." });
  }
  const columns = Object.keys(values);
  const result = db
    .prepare(
      `INSERT INTO b2b_accounts (${columns.join(", ")}) VALUES (${columns.map((c) => "@" + c).join(", ")})`,
    )
    .run(values);
  const account = db.prepare("SELECT * FROM b2b_accounts WHERE id = ?").get(result.lastInsertRowid);
  res.status(201).json({ success: true, account: publicAccount(account) });
});

// PUT /api/b2b/accounts/:id — partial; a password only when one is sent.
router.put("/accounts/:id", requireAuth, (req, res) => {
  const existing = db.prepare("SELECT * FROM b2b_accounts WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Cuenta no encontrada" });
  const { error, values } = cleanAccountInput(req.body, { partial: true });
  if (error) return res.status(400).json({ error });
  if (values.email !== undefined && emailTaken(values.email, existing.id)) {
    return res.status(409).json({ error: "Ya existe una cuenta con ese email." });
  }
  const columns = Object.keys(values);
  if (columns.length) {
    db.prepare(
      `UPDATE b2b_accounts SET ${columns.map((c) => `${c} = @${c}`).join(", ")}, updated_at = datetime('now') WHERE id = @id`,
    ).run({ ...values, id: existing.id });
  }
  const account = db.prepare("SELECT * FROM b2b_accounts WHERE id = ?").get(existing.id);
  res.json({ success: true, account: publicAccount(account) });
});

// Reservations keep their own b2b_company snapshot, so deleting an account
// does not blank out who its past orders were for.
router.delete("/accounts/:id", requireAuth, (req, res) => {
  const result = db.prepare("DELETE FROM b2b_accounts WHERE id = ?").run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: "Cuenta no encontrada" });
  res.json({ success: true });
});

export default router;
