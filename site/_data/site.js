import { getConfig, PUBLIC_CONFIG_KEYS } from "../../src/db/database.js";
import { formatContent } from "../../src/content/format-content.js";
import { renderFaqAccordions } from "../../src/content/faq-accordion.js";
import { splitCards } from "../../src/content/content-cards.js";
import { buildLocalBusinessLd, buildFaqLd } from "../../src/content/structured-data.js";
import { isSmtpConfigured } from "../../src/mail/mailer.js";
import {
  CONTACT_RETENTION_MONTHS,
  ORDER_RETENTION_YEARS,
} from "../../src/privacy/retention-periods.js";

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
  // The look of the site (DESIGN.md §2). Templates branch on this boolean;
  // anything else than "calida" is the original look.
  config.calida = config.site_style === "calida";
  // Content-shaped sections of the Cálida style (DESIGN.md §5.5, §5.8, slice
  // 2): build-time transforms over the sanitized HTML above, never over the
  // Markdown, so formatContent stays the only XSS boundary. Only in Cálida —
  // Clásico keeps the HTML byte for byte, so a release never changes a live
  // site's look. FAQ blocks first, so their ### questions are inside <details>
  // before the ### blocks of Servicios and Quiénes somos become cards. The
  // FAQPage data of a page rides with its accordions (same block, same gate),
  // keyed by the template's navActive for base.njk to emit.
  if (config.calida) {
    for (const k of ["index_body", "quienes_desc", "servicios_desc", "contacto_desc"]) {
      config[`page_${k}_html`] = renderFaqAccordions(config[`page_${k}_html`]);
    }
    config.page_servicios_cards = splitCards(config.page_servicios_desc_html);
    config.page_quienes_cards = splitCards(config.page_quienes_desc_html);
    config.page_faq_ld = {
      index: buildFaqLd(config.page_index_body),
      quienes: buildFaqLd(config.page_quienes_desc),
      servicios: buildFaqLd(config.page_servicios_desc),
      contacto: buildFaqLd(config.page_contacto_desc),
    };
  }
  // Hero highlights (DESIGN.md §5.2): one per line, at most three, trimmed.
  config.highlights = String(config.page_index_highlights || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 3);
  // Staging (X-Robots-Tag noindex in src/server.js) gates whether SEO
  // artifacts advertise the site — robots.txt/sitemap.xml consult this.
  config.staging = process.env.STAGING === "true";
  // LocalBusiness/Store JSON-LD emitted in the site <head> on every page (see
  // _includes/base.njk). Built after site_url/logo_ext are resolved above so
  // absolute url/image and the geo/address gating use the final values. Null
  // when there isn't enough business data — the template then emits nothing.
  config.local_business_ld = buildLocalBusinessLd(config);
  // Whether the site can send email at all. The order summary and the contact
  // form's copy are only emailed when it can (src/api/reservations.js,
  // src/api/contact.js), so the legal pages may only promise them then. A
  // boolean, never the SMTP settings themselves (those are secrets).
  config.mail_configured = isSmtpConfigured();
  // How a catalogue order is paid, in one line, for the catalogue hero and its
  // meta descriptions. Same rule as paymentInstructions in
  // src/api/reservations.js: with an IBAN, retail orders are paid by transfer
  // before they are prepared. "Sin pago por adelantado" was said here before
  // the transfer flow existed, and contradicted it.
  config.shop_payment_line = config.bank_iban
    ? "Pide online y paga por transferencia bancaria"
    : "Pide online y paga al recibir tu pedido";
  // The privacy policy states the periods the purge enforces
  // (src/privacy/retention.js), read from the same constants.
  config.retention = {
    contactMonths: CONTACT_RETENTION_MONTHS,
    orderYears: ORDER_RETENTION_YEARS,
  };
  return config;
}
