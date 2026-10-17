// Splits sanitized HTML into its top-level blocks, for the build-time
// transforms that reshape a page body (src/content/content-cards.js,
// src/content/faq-accordion.js).
//
// The input is always formatContent() output: balanced, lowercase tags, every
// "<" in text or attribute values already escaped. That is what makes a
// depth-counting scan reliable here where it would not be on arbitrary HTML
// (lib/table-scroll.mjs does the same for tables, for the same reason). It is
// not a parser and must never run on anything that has not been through the
// sanitizer first.
//
// Returns [{ tag, html }] in document order — `tag` is the block's element
// name ("p", "h3", "ul", …), or "#text" for bare text at the top level — or
// null when the markup is unbalanced, so a caller leaves the HTML untouched.
// Whitespace between blocks is dropped; callers join with "\n".

const TAG_RE = /<(\/?)([a-z][a-z0-9-]*)\b[^>]*?(\/?)>/gi;

// Elements that never have a closing tag. sanitize-html writes them as
// `<br />`, but a plain `<br>` is handled too.
const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
  "param", "source", "track", "wbr",
]);

export function splitBlocks(html) {
  const blocks = [];
  const src = String(html ?? "");
  let depth = 0;
  let start = 0;
  let tag = null;
  let cursor = 0; // end of the last block emitted, for top-level text
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(src)) !== null) {
    const [whole, closing, rawName, selfClosing] = m;
    const name = rawName.toLowerCase();
    const isVoid = VOID.has(name) || selfClosing === "/";
    if (depth === 0) {
      const text = src.slice(cursor, m.index);
      if (text.trim()) blocks.push({ tag: "#text", html: text });
      if (closing) return null; // a stray closing tag: not our markup
      if (isVoid) {
        blocks.push({ tag: name, html: whole });
        cursor = m.index + whole.length;
        continue;
      }
      start = m.index;
      tag = name;
      depth = 1;
      continue;
    }
    if (isVoid) continue;
    if (!closing) {
      depth += 1;
      continue;
    }
    depth -= 1;
    if (depth === 0) {
      cursor = m.index + whole.length;
      blocks.push({ tag, html: src.slice(start, cursor) });
    }
  }
  if (depth !== 0) return null;
  const tail = src.slice(cursor);
  if (tail.trim()) blocks.push({ tag: "#text", html: tail });
  return blocks;
}

// The text of an HTML fragment: tags removed, the entities the sanitizer
// writes decoded. For headings and alt texts, never for output.
export function textOf(html) {
  return String(html ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// The inner HTML of a block: the element's own open and close tags removed.
export function innerOf(blockHtml) {
  return String(blockHtml ?? "")
    .replace(/^<[a-z][a-z0-9-]*\b[^>]*>/i, "")
    .replace(/<\/[a-z][a-z0-9-]*\s*>$/i, "")
    .trim();
}
