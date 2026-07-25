import { marked } from "marked";
import sanitizeHtml from "sanitize-html";

marked.setOptions({ breaks: true });

// Shared markdown → sanitized HTML pipeline. Used by the blog (site/_data/
// articles.js) and the page body/desc fields (site/_data/site.js) so both
// paths share one security allowlist.
//
// breaks:true keeps a lone "\n" rendering as <br>, so legacy plain-text content
// (no markdown syntax) renders unchanged — existing sites stay backward compatible.
export function formatContent(text) {
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
