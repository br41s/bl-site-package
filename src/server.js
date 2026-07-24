import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { getConfig, DB_PATH } from "./db/database.js";
import { buildOnStartup } from "./build/rebuild.js";
import authRouter from "./api/auth.js";
import chatRouter from "./api/chat.js";
import blogRouter from "./api/blog.js";
import contactRouter from "./api/contact.js";
import setupRouter from "./api/setup.js";
import siteRouter from "./api/site.js";
import productsRouter from "./api/products.js";
import reservationsRouter from "./api/reservations.js";
import syncRouter from "./api/sync.js";
import { startLiderpapelScheduler } from "./sync/liderpapel/scheduler.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

const uploadsDir = join(__dirname, "../data/uploads");
mkdirSync(uploadsDir, { recursive: true });

// No CORS middleware on purpose: site, panel and every /api consumer are
// served from this same origin, so cross-origin API access stays blocked.
app.use(express.json());

// En subdominios de staging (STAGING=true en las variables de entorno),
// evita que buscadores indexen el contenido sin necesitar autenticación.
if (process.env.STAGING === "true") {
  app.use((req, res, next) => {
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    next();
  });
}

app.use((req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    // img-src allows Liderpapel's product-image host so hotlinked catalog
    // images aren't silently blocked. TODO: confirm the exact media host
    // once real MultimediaLinks URLs are seen (see src/sync/liderpapel/mapping.js).
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://api.fontshare.com; font-src 'self' https://fonts.gstatic.com https://api.fontshare.com; img-src 'self' data: blob: https://*.liderpapel.com; connect-src 'self' https://openrouter.ai; frame-ancestors 'none'",
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});

// Belt-and-suspenders: nothing under /data is ever served over HTTP, even if a
// future static mount or a symlink would otherwise expose it. 404 (not 403) so
// we don't confirm the path exists. Registered before any static handler so it
// always wins. (Uploads are served at /uploads, not /data, so this is safe.)
app.use("/data", (req, res) => res.status(404).end());

app.use("/uploads", express.static(uploadsDir));

// API routes
app.use("/api/auth", authRouter);
app.use("/api/chat", chatRouter);
app.use("/api/blog", blogRouter);
app.use("/api/contact", contactRouter);
app.use("/api/setup", setupRouter);
app.use("/api/site", siteRouter);
app.use("/api/products", productsRouter);
app.use("/api/reservations", reservationsRouter);
app.use("/api/sync", syncRouter);

// Panel & Setup
app.get("/setup", (req, res) =>
  res.sendFile(join(__dirname, "../web/setup.html")),
);
app.get("/panel", (req, res) => {
  const configured = !!(
    process.env.PANEL_PASSWORD || getConfig("panel_password")
  );
  if (!configured) return res.redirect("/setup");
  res.sendFile(join(__dirname, "../web/panel.html"));
});

// Public site pages — Eleventy-built static HTML (site/ -> _site/), rebuilt
// on every content write (see src/build/rebuild.js). `extensions: ["html"]`
// keeps clean URLs (/servicios, /blog/:slug) without redirects.
app.use(
  express.static(join(__dirname, "../_site"), { extensions: ["html"] }),
);

// Panel/setup assets (panel.js, setup.js, style-panel.css, etc.)
app.use(express.static(join(__dirname, "../web")));

// 404
app.use((req, res) => {
  res.status(404).sendFile(join(__dirname, "../web/404.html"), (err) => {
    if (err) res.status(404).json({ error: "Not found" });
  });
});

await buildOnStartup();
startLiderpapelScheduler();

app.listen(PORT, () => {
  console.log(`🦞 bl-site-package running on port ${PORT}`);
  console.log(`   Panel: http://localhost:${PORT}/panel`);
  console.log(`   Setup: http://localhost:${PORT}/setup`);
  console.log(`   DB:    ${DB_PATH} (keep OUTSIDE the web document root — see RELEASE.md)`);
});

export default app;
