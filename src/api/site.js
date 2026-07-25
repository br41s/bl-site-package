import express from "express";
import multer from "multer";
import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig, setConfig, PUBLIC_CONFIG_KEYS } from "../db/database.js";
import { requireAuth } from "../middleware/auth.js";
import { optimizeToWebp } from "../media/optimize-image.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const uploadsDir = join(__dirname, "../../data/uploads");
mkdirSync(uploadsDir, { recursive: true });

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
