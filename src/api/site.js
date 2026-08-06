import express from "express";
import multer from "multer";
import { mkdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import db, { getConfig, setConfig, PUBLIC_CONFIG_KEYS } from "../db/database.js";
import { requireAuth } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { optimizeToWebp } from "../media/optimize-image.js";
import { getBuildState } from "../build/rebuild.js";
import { formatContent } from "../content/format-content.js";
import {
  getMailSettings,
  isSmtpConfigured,
  isNotifyEmailConfigured,
  sendMail,
  getLastContactEmail,
} from "../mail/mailer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const uploadsDir = join(__dirname, "../../data/uploads");
mkdirSync(uploadsDir, { recursive: true });

// The deployed release, so a monitoring caller can tell an instance running an
// old build from an up-to-date one. package.json is the only version this repo
// has — there is no git checkout in the container (the Dockerfile COPYs the
// tree) — so bumping it in a release is what makes this field move.
const APP_VERSION = JSON.parse(
  readFileSync(join(__dirname, "../../package.json"), "utf8"),
).version;

// Accepted logo formats. SVG is intentionally excluded: an SVG with an inline
// <script> served from /uploads (same-origin, and the CSP allows
// script-src 'unsafe-inline') is a stored-XSS vector. Only raster formats are
// allowed. The extension is taken from this validated-mimetype map, never from
// the client-controlled originalname.
const LOGO_MIME_EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    cb(null, "logo." + LOGO_MIME_EXT[file.mimetype]);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (LOGO_MIME_EXT[file.mimetype]) cb(null, true);
    else cb(new Error("Solo se permiten imágenes PNG, JPG o WebP"));
  },
});

const router = express.Router();

// GET /api/site/config — public
router.get("/config", (req, res) => {
  const config = {};
  for (const k of PUBLIC_CONFIG_KEYS) config[k] = getConfig(k);
  res.json(config);
});

// POST /api/site/texts — save page texts
router.post("/texts", requireAuth, (req, res) => {
  const allowed = [
    "site_url",
    "page_index_title",
    "page_index_subtitle",
    "page_index_desc",
    "page_index_body",
    "page_quienes_title",
    "page_quienes_subtitle",
    "page_quienes_desc",
    "page_servicios_title",
    "page_servicios_subtitle",
    "page_servicios_desc",
    "page_contacto_title",
    "page_contacto_subtitle",
    "page_contacto_desc",
    "page_blog_title",
    "page_blog_subtitle",
    "smtp_host",
    "smtp_port",
    "smtp_user",
    "smtp_pass",
    "notify_email",
    "ai_model",
    "image_model",
    "page_index_image",
    "page_index_image_alt",
    "page_quienes_image",
    "page_quienes_image_alt",
    "page_servicios_image",
    "page_servicios_image_alt",
    "page_contacto_image",
    "page_contacto_image_alt",
    "whatsapp_number",
    "legal_name",
    "legal_id",
    "legal_address",
    "legal_email",
    "biz_type",
    "biz_street",
    "biz_city",
    "biz_postal_code",
    "biz_region",
    "biz_country",
    "biz_phone",
    "biz_geo_lat",
    "biz_geo_lng",
    "biz_hours",
    "biz_price_range",
    "biz_facebook",
    "biz_instagram",
  ];
  for (const key of allowed) {
    if (req.body[key] !== undefined) setConfig(key, req.body[key]);
  }
  res.json({ success: true });
});

// POST /api/site/logo — upload logo. The multer error callback turns a
// rejected upload (wrong type, too large) into a clean 400 instead of the
// default 500 HTML error page.
router.post("/logo", requireAuth, (req, res) => {
  upload.single("logo")(req, res, (err) => {
    if (err)
      return res.status(400).json({
        error: err.message || "No se pudo subir el archivo",
      });
    if (!req.file)
      return res.status(400).json({ error: "No se recibió ningún archivo" });
    const ext = LOGO_MIME_EXT[req.file.mimetype];
    setConfig("logo_ext", ext);
    res.json({ success: true, path: "/uploads/logo." + ext });
  });
});

// POST /api/site/upload-image — store a generated/uploaded image.
// Body: { image_base64 } (bare base64 or a data: URI). The bytes are decoded,
// validated as a safe raster format, downscaled and re-encoded to WebP (see
// optimizeToWebp — re-encoding is the security boundary), then written under
// data/uploads with a content-hash filename so identical images dedupe and the
// name is never client-controlled. Returns the public /uploads URL. The large
// base64 body is parsed by a route-scoped express.json limit (see server.js).
router.post("/upload-image", requireAuth, async (req, res) => {
  try {
    const { buffer, filename } = await optimizeToWebp(req.body?.image_base64);
    await writeFile(join(uploadsDir, filename), buffer);
    res.json({ success: true, url: "/uploads/" + filename });
  } catch (err) {
    res.status(400).json({ error: err.message || "No se pudo procesar la imagen" });
  }
});

// GET /api/site/status — operational health for the maintenance agent.
//
// Authenticated: this is the panel's own view of the instance, not something a
// visitor needs. It answers three questions that are otherwise unanswerable
// from outside a client's deploy: is this instance on the current release, did
// the last background rebuild succeed, and can the instance send mail at all.
//
// Presence booleans only, never values. The SMTP host, user, password and the
// notification address are all in the same config table as the panel password
// and the client's OpenRouter key; this endpoint reports whether they are set
// and nothing more.
router.get("/status", requireAuth, (req, res) => {
  const settings = getMailSettings();
  const build = getBuildState();

  const counts = Object.fromEntries(
    db
      .prepare("SELECT status, COUNT(*) AS n FROM articles GROUP BY status")
      .all()
      .map((row) => [row.status, row.n]),
  );

  res.json({
    version: APP_VERSION,
    built_at: build.at,
    last_build_ok: build.ok,
    smtp_configured: isSmtpConfigured(settings),
    notify_email_configured: isNotifyEmailConfigured(settings),
    posts: {
      published: counts.published || 0,
      draft: counts.draft || 0,
    },
    // Outcome of the last contact-form notification e-mail, or null if this
    // process has not attempted one. Error class only (e.g. "EAUTH") — SMTP
    // rejection strings routinely echo the username back.
    last_contact_email: getLastContactEmail(),
  });
});

// Rate limit for /notify. The legitimate caller is the maintenance agent's
// monthly report — one call a month — so a handful a day is generous by orders
// of magnitude while still meaning a leaked panel password cannot turn a
// client's site into a mailer.
const notifyLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 10,
  message: "Demasiadas notificaciones enviadas, inténtalo mañana.",
});

const MAX_SUBJECT = 200;
const MAX_BODY = 50000;

// POST /api/site/notify — send an operational e-mail to the site owner.
// Body: { subject, body_markdown }. Goes out through the instance's own SMTP
// (src/mail/mailer.js, the same pathway the contact form uses) to its
// configured notify_email. The recipient is never taken from the request:
// this endpoint reaches the site owner and nobody else, so a stolen panel
// token cannot aim it at a third party.
router.post("/notify", requireAuth, notifyLimiter, async (req, res) => {
  const subject =
    typeof req.body?.subject === "string" ? req.body.subject.trim() : "";
  const bodyMarkdown =
    typeof req.body?.body_markdown === "string"
      ? req.body.body_markdown.trim()
      : "";

  if (!subject || !bodyMarkdown) {
    return res.status(400).json({
      error: "invalid_body",
      message: "subject y body_markdown son obligatorios",
    });
  }
  if (subject.length > MAX_SUBJECT || bodyMarkdown.length > MAX_BODY) {
    return res.status(400).json({
      error: "invalid_body",
      message: "subject o body_markdown demasiado largo",
    });
  }

  const settings = getMailSettings();
  if (!isSmtpConfigured(settings) || !isNotifyEmailConfigured(settings)) {
    return res.status(503).json({
      error: "smtp_not_configured",
      message: "El envío de email no está configurado en esta instalación",
    });
  }

  try {
    await sendMail(
      {
        from: `"${getConfig("company_name") || "Web"}" <${settings.user}>`,
        to: settings.notifyEmail,
        subject,
        // Plain text keeps the markdown source readable in any client; the
        // HTML part goes through the site's own markdown pipeline, so this
        // endpoint adds no second sanitizer to keep in sync.
        text: bodyMarkdown,
        html: formatContent(bodyMarkdown),
      },
      settings,
    );
    res.json({ success: true });
  } catch (err) {
    // Unlike the contact form, this failure is surfaced: the caller is a
    // monitoring agent whose whole job is to notice it.
    console.error("Error enviando notificación:", err.message);
    res.status(502).json({
      error: "send_failed",
      message: "No se pudo enviar el email de notificación",
    });
  }
});

// GET /api/site/models?q=term — proxy OpenRouter model list
router.get("/models", requireAuth, async (req, res) => {
  const q = (req.query.q || "").toLowerCase().trim();
  const apiKey =
    process.env.OPENROUTER_API_KEY?.trim() ||
    getConfig("openrouter_api_key")?.trim();
  try {
    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    const response = await fetch("https://openrouter.ai/api/v1/models", {
      headers,
    });
    const data = await response.json();
    let models = (data.data || []).map((m) => ({
      id: m.id,
      name: m.name || m.id,
      pricing: m.pricing || null,
    }));
    if (q)
      models = models.filter(
        (m) =>
          m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q),
      );
    res.json({ models: models.slice(0, 30) });
  } catch (err) {
    console.error("Models fetch error:", err);
    res
      .status(500)
      .json({ error: "No se pudo obtener la lista de modelos", models: [] });
  }
});

export default router;
