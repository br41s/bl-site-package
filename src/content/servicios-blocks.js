import { splitBlocks, innerOf, textOf } from "./html-blocks.js";

// Optional blocks above the body of /servicios, driven by ONE config key,
// `servicios_blocks` (JSON, public). Empty = the page is exactly as before.
//
//   {
//     "overview": ["printer", "file", …],      // icon per section, in order
//     "ai": {
//       "title": "…", "intro": "…",
//       "url": "https://…", "label": "…",
//       "cards": [{ "icon": "shield", "title": "…", "text": "…" }, …]
//     }
//   }
//
// Both halves are independent and both are content, not code: the package
// carries no customer's wording and no third party's name. The overview is
// derived from the body's own `##` sections (title, first paragraph, anchor),
// so it cannot drift from the text below it; `overview` only picks the icons,
// by position. `ai` is a set of cards plus one outbound link, for a customer
// who resells or refers a partner's service.
//
// Anchors are written onto the already-sanitized HTML (never onto Markdown),
// so formatContent stays the one XSS boundary; ids are slugs of the heading
// text, written here and nowhere else.

// Names the icon.njk partial draws. src/content/servicios-blocks.test.js
// fails if one is listed here and missing there.
export const ICON_NAMES = [
  "printer", "file", "megaphone", "monitor", "shirt", "desk", "box", "truck",
  "star", "shield", "chat", "pencil", "search", "chart", "globe", "refresh",
  "compass", "tag", "rocket", "sparkle", "check", "cart", "mail", "phone",
];

const MAX_CARDS = 12;
const MAX_TITLE = 80;
const MAX_TEXT = 400;

const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const icon = (v) => (ICON_NAMES.includes(v) ? v : "sparkle");

// https only, no credentials: the URL is rendered into an href on a public page.
function httpsUrl(v) {
  try {
    const u = new URL(String(v));
    return u.protocol === "https:" && !u.username && !u.password ? u.href : "";
  } catch {
    return "";
  }
}

// Lenient form for the build: drops what is unusable, never throws.
export function parseServiciosBlocks(raw) {
  let obj;
  try {
    obj = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const overview = Array.isArray(obj.overview) ? obj.overview.map(icon) : null;
  let ai = null;
  const a = obj.ai;
  if (a && typeof a === "object") {
    const cards = (Array.isArray(a.cards) ? a.cards : [])
      .map((c) => ({ icon: icon(c?.icon), title: str(c?.title, MAX_TITLE), text: str(c?.text, MAX_TEXT) }))
      .filter((c) => c.title && c.text)
      .slice(0, MAX_CARDS);
    const url = httpsUrl(a.url);
    const title = str(a.title, MAX_TITLE);
    if (cards.length && url && title) {
      ai = { title, intro: str(a.intro, MAX_TEXT * 2), url, label: str(a.label, MAX_TITLE) || "Ver todos los servicios", cards };
    }
  }
  return overview || ai ? { overview, ai } : null;
}

// Strict form for the panel/API: "" clears; anything else must parse whole.
export function isValidServiciosBlocks(raw) {
  if (raw === "") return true;
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  if (obj.overview !== undefined && !(Array.isArray(obj.overview) && obj.overview.every((i) => ICON_NAMES.includes(i)))) return false;
  if (obj.ai !== undefined) {
    const a = obj.ai;
    if (!a || typeof a !== "object" || !str(a.title, MAX_TITLE) || !httpsUrl(a.url)) return false;
    if (!Array.isArray(a.cards) || !a.cards.length || a.cards.length > MAX_CARDS) return false;
    if (!a.cards.every((c) => c && str(c.title, MAX_TITLE) && str(c.text, MAX_TEXT) && ICON_NAMES.includes(c.icon))) return false;
  }
  return obj.overview !== undefined || obj.ai !== undefined;
}

function slug(text) {
  return text
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
    .slice(0, 60) || "seccion";
}

function shorten(text, max = 120) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max).replace(/\s+\S*$/, "");
  return `${cut}…`;
}

// Gives every `##` of the sanitized body an id and returns the overview items.
// Unbalanced markup (splitBlocks null) leaves the HTML as it came, no items.
export function anchorSections(html, icons) {
  const blocks = splitBlocks(html);
  if (!blocks) return { html, items: [] };
  const used = new Set();
  const items = [];
  const out = [];
  let item = null;
  for (const b of blocks) {
    if (b.tag === "h2") {
      const title = innerOf(b.html);
      const plain = textOf(title);
      let id = slug(plain);
      for (let n = 2; used.has(id); n += 1) id = `${slug(plain)}-${n}`;
      used.add(id);
      item = { id, title, plainTitle: plain, text: "", icon: icons[items.length] || "sparkle" };
      items.push(item);
      out.push(`<h2 id="${id}">${title}</h2>`);
      continue;
    }
    if (item && !item.text && b.tag === "p") item.text = shorten(textOf(b.html));
    out.push(b.html);
  }
  return { html: out.join("\n"), items };
}
