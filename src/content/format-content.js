import { marked } from "marked";
import sanitizeHtml from "sanitize-html";

marked.setOptions({ breaks: true });

// Shared markdown → sanitized HTML pipeline. Used by the blog (site/_data/
// articles.js) and the page body/desc fields (site/_data/site.js) so both
// paths share one security allowlist.
//
// breaks:true keeps a lone "\n" rendering as <br>, so legacy plain-text content
// (no markdown syntax) renders unchanged — existing sites stay backward compatible.
// Inline-SVG subset allowed inside content, for the code-drawn infographics the
// infographic agent inserts. Deliberately conservative — shapes, text and
// grouping only. Everything with a known sanitizer-bypass or fetch capability
// stays out: no <script>/<style>, no <foreignObject> (re-enters HTML parsing),
// no <use>/<defs>/<marker> (reference-based bypasses), no <image> (external
// fetch), no SMIL <animate>/<set>. The cost is arrowheads and gradients; the
// benefit is that this list has no way to execute or phone home.
//
// Every tag here is lowercase on purpose: sanitize-html lowercases tag names,
// so camelCase SVG elements (clipPath, linearGradient) could not survive anyway.
const SVG_TAGS = [
  "svg", "g", "title", "desc",
  "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
  "text", "tspan",
];

// Presentation attributes shared by the shape/text elements. No `style` (url()
// and expression() vectors), no `href`/`xlink:href`, no `on*` — sanitize-html
// drops anything not named here, so event handlers cannot get through.
const SVG_COMMON_ATTRS = [
  "fill", "fill-opacity", "fill-rule",
  "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin",
  "stroke-dasharray", "stroke-opacity",
  "opacity", "transform", "class",
];

export function formatContent(text) {
  if (!text) return "";
  return sanitizeHtml(marked.parse(text), {
    allowedTags: [
      "p", "br", "h2", "h3", "h4", "ul", "ol", "li", "strong", "em",
      "a", "table", "thead", "tbody", "tr", "td", "th", "blockquote",
      "figure", "figcaption",
      ...SVG_TAGS,
    ],
    allowedAttributes: {
      a: ["href", "rel", "target"],
      figure: ["class"],
      // viewBox is written lowercase here because sanitize-html lowercases
      // attribute names; the HTML parser's SVG adjustment table maps `viewbox`
      // back to `viewBox` for inline SVG, so responsive scaling still works.
      svg: [...SVG_COMMON_ATTRS, "viewbox", "xmlns", "width", "height",
        "preserveaspectratio", "role", "aria-label", "aria-labelledby"],
      g: SVG_COMMON_ATTRS,
      path: [...SVG_COMMON_ATTRS, "d"],
      rect: [...SVG_COMMON_ATTRS, "x", "y", "width", "height", "rx", "ry"],
      circle: [...SVG_COMMON_ATTRS, "cx", "cy", "r"],
      ellipse: [...SVG_COMMON_ATTRS, "cx", "cy", "rx", "ry"],
      line: [...SVG_COMMON_ATTRS, "x1", "y1", "x2", "y2"],
      polyline: [...SVG_COMMON_ATTRS, "points"],
      polygon: [...SVG_COMMON_ATTRS, "points"],
      text: [...SVG_COMMON_ATTRS, "x", "y", "dx", "dy", "text-anchor",
        "dominant-baseline", "font-size", "font-weight"],
      tspan: [...SVG_COMMON_ATTRS, "x", "y", "dx", "dy", "text-anchor",
        "font-size", "font-weight"],
    },
  });
}
