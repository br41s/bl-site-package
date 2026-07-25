// schema.org JSON-LD builders. Kept in the src/ layer (not inline in the
// Nunjucks templates) so the conditional field-omission, geo/hours validation
// and FAQ parsing live in plain JS where they're readable and testable. The
// _data files (site/_data/site.js, site/_data/articles.js) call these at build
// time and the templates just emit the returned object via the `jsonLd` filter.
//
// Design rule shared by every builder: emit a property ONLY when its source
// value is present and well-formed. A LocalBusiness/Article/FAQPage with blank
// or malformed required props is worse than a smaller-but-valid one (Google
// Rich Results flags empty/invalid props), so we never output placeholders.

const DAY_TOKENS = new Set(["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]);

// A single schema.org `openingHours` entry, e.g. "Mo-Fr 09:00-13:30,16:30-20:00"
// or "Sa 10:00-14:00". We validate strictly so a client typing free-form
// Spanish ("Lunes a viernes...") yields NO openingHours rather than an invalid
// one — the value still renders as plain text on the contact page regardless.
const HOURS_ENTRY =
  /^(Mo|Tu|We|Th|Fr|Sa|Su)(-(Mo|Tu|We|Th|Fr|Sa|Su))?\s+([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d(,([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d)*$/;

function parseOpeningHours(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[\n;]+/)
    .map((s) => s.trim())
    .filter((s) => {
      if (!HOURS_ENTRY.test(s)) return false;
      // Guard the day tokens against typos the regex alphabet can't catch.
      const days = s.split(/\s+/)[0].split("-");
      return days.every((d) => DAY_TOKENS.has(d));
    });
}

// @type must be a bare schema.org LocalBusiness (sub)type. Anything else (empty,
// spaces, punctuation) falls back to the generic LocalBusiness so the emitted
// type is always a valid schema.org class.
function sanitizeType(raw) {
  const v = (raw || "").trim();
  return /^[A-Za-z]+$/.test(v) ? v : "LocalBusiness";
}

// SQLite datetime('now') stores 'YYYY-MM-DD HH:MM:SS' in UTC with no timezone.
// schema.org date props want ISO 8601, so normalize to '...THH:MM:SSZ'. Values
// that already look ISO (contain 'T') are passed through untouched.
function toIso(dt) {
  if (!dt) return undefined;
  const s = String(dt).trim();
  if (!s) return undefined;
  return s.includes("T") ? s : s.replace(" ", "T") + "Z";
}

// Flatten a markdown answer to plain text for a schema.org Answer.text. Keeps
// link labels, drops the markup — Answer.text is meant to be human-readable
// prose, and plain text is always valid.
function mdToPlain(md) {
  return String(md || "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`#>]/g, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

// LocalBusiness / Store JSON-LD for the site <head> (every page). Returns null
// when there isn't enough to describe a real business location — we require the
// name plus at least one locating signal (postal address, geo, or phone) so we
// never emit a name-only stub. `config` is the same object site/_data/site.js
// builds from PUBLIC_CONFIG_KEYS.
export function buildLocalBusinessLd(config) {
  const name = (config.company_name || "").trim();
  if (!name) return null;

  const address = {};
  const addrParts = {
    streetAddress: config.biz_street,
    addressLocality: config.biz_city,
    postalCode: config.biz_postal_code,
    addressRegion: config.biz_region,
    addressCountry: config.biz_country,
  };
  for (const [k, v] of Object.entries(addrParts)) {
    const t = (v || "").trim();
    if (t) address[k] = t;
  }
  const hasAddress = Object.keys(address).length > 0;

  const lat = parseFloat(config.biz_geo_lat);
  const lng = parseFloat(config.biz_geo_lng);
  const hasGeo =
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180;

  // Explicit phone wins; otherwise reuse the WhatsApp number the client already
  // entered (digits only → E.164) rather than asking for the same data twice.
  let phone = (config.biz_phone || "").trim();
  if (!phone && config.whatsapp_number) {
    const wa = String(config.whatsapp_number).replace(/\D/g, "");
    if (wa) phone = "+" + wa;
  }

  if (!hasAddress && !hasGeo && !phone) return null;

  const ld = {
    "@context": "https://schema.org",
    "@type": sanitizeType(config.biz_type),
    name,
  };

  const url = (config.site_url || "").trim();
  if (url) ld.url = url;
  if (phone) ld.telephone = phone;
  if (hasAddress) ld.address = { "@type": "PostalAddress", ...address };
  if (hasGeo)
    ld.geo = { "@type": "GeoCoordinates", latitude: lat, longitude: lng };

  const hours = parseOpeningHours(config.biz_hours);
  if (hours.length) ld.openingHours = hours;

  const priceRange = (config.biz_price_range || "").trim();
  if (priceRange) ld.priceRange = priceRange;

  const email = (config.legal_email || "").trim();
  if (email) ld.email = email;

  if (url && config.logo_ext) ld.image = `${url}/uploads/logo.${config.logo_ext}`;

  const sameAs = [config.biz_facebook, config.biz_instagram]
    .map((s) => (s || "").trim())
    .filter(Boolean);
  if (sameAs.length) ld.sameAs = sameAs;

  return ld;
}

// BlogPosting JSON-LD for a single article. `site` carries company_name,
// site_url and logo_ext (resolved the same way as the LocalBusiness config).
// The post URL mirrors the canonical form (permalink is /blog/<slug>.html but
// the served/canonical URL drops .html — see eleventyConfig.absoluteUrl).
export function buildArticleLd(article, site) {
  if (!article || !article.title) return null;
  const publisherName = (site.company_name || "").trim() || article.title;

  const ld = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: article.title,
    author: { "@type": "Organization", name: publisherName },
    publisher: { "@type": "Organization", name: publisherName },
  };

  const published = toIso(article.created_at);
  if (published) ld.datePublished = published;
  const modified = toIso(article.updated_at || article.created_at);
  if (modified) ld.dateModified = modified;
  if (article.excerpt) ld.description = article.excerpt;

  const url = (site.site_url || "").trim();
  if (url) {
    const postUrl = `${url}/blog/${article.slug}`;
    ld.url = postUrl;
    ld.mainEntityOfPage = { "@type": "WebPage", "@id": postUrl };
    if (site.logo_ext) {
      ld.publisher.logo = {
        "@type": "ImageObject",
        url: `${url}/uploads/logo.${site.logo_ext}`,
      };
    }
  }

  return ld;
}

// FAQPage JSON-LD parsed from an article's raw markdown. Keys off the FAQ
// convention the content agents emit: an H2 whose text matches "preguntas
// frecuentes"/"FAQ", followed by each question as an H3 with its answer in the
// lines beneath. Returns null unless at least two well-formed Q&A pairs are
// found, so a stray heading never produces an empty FAQPage.
export function buildFaqLd(content) {
  if (!content) return null;

  const faqHeading = /^#{2,3}\s+.*\b(preguntas\s+frecuentes|preguntas\s+y\s+respuestas|faq)\b/i;
  const lines = String(content).split(/\r?\n/);
  const items = [];
  let inFaq = false;
  let current = null;

  const flush = () => {
    if (current && current.answer.trim()) {
      items.push({ q: current.q, a: current.answer.trim() });
    }
    current = null;
  };

  for (const line of lines) {
    if (!inFaq) {
      if (faqHeading.test(line)) inFaq = true;
      continue;
    }
    const h3 = /^###\s+(.*)$/.exec(line);
    const h2 = /^##\s+(.*)$/.exec(line);
    if (h3) {
      flush();
      current = { q: h3[1].trim(), answer: "" };
    } else if (h2) {
      // A new H2 (not the FAQ heading, already consumed) ends the FAQ block.
      flush();
      inFaq = false;
    } else if (current) {
      current.answer += (current.answer ? "\n" : "") + line;
    }
  }
  flush();

  if (items.length < 2) return null;
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((it) => ({
      "@type": "Question",
      name: it.q,
      acceptedAnswer: { "@type": "Answer", text: mdToPlain(it.a) },
    })),
  };
}
