import { getConfig, PUBLIC_CONFIG_KEYS } from "../../src/db/database.js";
import { formatContent } from "../../src/content/format-content.js";
import { buildLocalBusinessLd } from "../../src/content/structured-data.js";

// Eleventy global data — same key set as GET /api/site/config, read directly
// at build time instead of over HTTP.
export default function () {
  const config = { year: new Date().getFullYear() };
  for (const k of PUBLIC_CONFIG_KEYS) config[k] = getConfig(k) || "";
  // Markdown-rendered variants for the long-form body fields. Templates output
  // these with `| safe` (already sanitized) instead of the raw text, so the
  // agent can write structured content (headings, lists, bold, links) and pages
  // render enriched — not one flat paragraph. Plain-text values render unchanged
  // (see formatContent). The raw fields stay for the hero blurb and SEO meta.
  config.page_index_body_html = formatContent(config.page_index_body);
  config.page_quienes_desc_html = formatContent(config.page_quienes_desc);
  config.page_servicios_desc_html = formatContent(config.page_servicios_desc);
  config.page_contacto_desc_html = formatContent(config.page_contacto_desc);
  // site_url env override (SITE_URL) mirrors the runtime pattern used for
  // secrets like PANEL_PASSWORD; trailing slashes are stripped so templates
  // can concatenate absolute URLs without doubling the separator.
  config.site_url = (process.env.SITE_URL || config.site_url || "").replace(/\/+$/, "");
  // Staging (X-Robots-Tag noindex in src/server.js) gates whether SEO
  // artifacts advertise the site — robots.txt/sitemap.xml consult this.
  config.staging = process.env.STAGING === "true";
  // LocalBusiness/Store JSON-LD emitted in the site <head> on every page (see
  // _includes/base.njk). Built after site_url/logo_ext are resolved above so
  // absolute url/image and the geo/address gating use the final values. Null
  // when there isn't enough business data — the template then emits nothing.
  config.local_business_ld = buildLocalBusinessLd(config);
  return config;
}
