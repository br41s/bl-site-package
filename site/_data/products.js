import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import db from "../../src/db/database.js";
import { enrichProduct } from "./lib/enrichProduct.js";

marked.setOptions({ breaks: true });

function formatDescription(text) {
  if (!text) return "";
  return sanitizeHtml(marked.parse(text), {
    allowedTags: [
      "p", "br", "h2", "h3", "h4", "ul", "ol", "li", "strong", "em",
      "a", "table", "thead", "tbody", "tr", "td", "th", "blockquote",
    ],
    allowedAttributes: {
      a: ["href", "rel", "target"],
    },
  });
}

export default function () {
  const rows = db
    .prepare(
      "SELECT * FROM products WHERE active = 1 AND feed_active = 1 ORDER BY category, name COLLATE NOCASE",
    )
    .all();
  return rows.map((p) => ({
    ...enrichProduct(p),
    descriptionHtml: formatDescription(p.description),
  }));
}
