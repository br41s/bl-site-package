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
  "stroke-dasharray", "stroke-dashoffset", "stroke-opacity",
  "opacity", "transform", "class",
];

// var() IN GEOMETRY ATTRIBUTES — a trap this allowlist cannot close.
//
// The attributes below split into two kinds, and the difference is invisible:
//
//   fill, stroke, stop-color, font-family, opacity, stroke-width, font-size
//     are CSS properties. As presentation attributes, var() DOES resolve, so
//     fill="var(--accent)" themes correctly in light and dark.
//
//   x, y, width, height, rx, ry, cx, cy, r, x1/y1/x2/y2, dx, dy, points, d
//     are NOT CSS properties. They parse as SVG data types, var() is ignored,
//     and the attribute falls back to its default — rx=0, width=0 — with no
//     browser error and nothing wrong-looking in the markup.
//
// So <rect rx="var(--radius)"> renders square corners and reads as correct.
// This shipped on the flagship site: 40 rects across 7 articles (br41s/biglobster
// PR #488), and the agent that drew them regenerated it on the very next run.
//
// WHY WE DO NOT POLICE IT HERE, and please do not "fix" that:
//
//   1. Wrong layer. This sanitizer is a security boundary. Stripping or
//      rewriting a *cosmetic* mistake here mixes two jobs, and a stripped
//      attribute renders exactly as badly as the unresolved one.
//   2. We cannot know the right value. --radius is per-client, set from
//      site.radius_style in site/_includes/base.njk. Substituting a constant
//      would override the style the client chose.
//   3. Failing the build is worse than the bug. runBuild() in src/build/
//      rebuild.js catches Eleventy errors and keeps serving the previous
//      _site/, so throwing here would silently stop ALL publishing for that
//      client — publish drift — with no human in the loop to notice.
//
// The fix belongs in the drawing agent's prompt: plain numbers in geometry
// attributes. biglobster additionally has a build-time guard
// (lib/svg-token-guard.mjs) because there a failed build is loud and a human
// merges every change; neither is true here.
//
// If you ever want genuinely per-client rounded corners, the route is CSS, not
// the attribute — `.article-infographic rect { rx: var(--radius); }` does
// resolve (verified in Chromium). Check Safari before relying on it: rx/ry as
// CSS geometry properties are not universally supported, and a silent fallback
// there is the same class of bug.

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
      // `aria-labelledby` on <svg> points at a <title>/<desc> by id, so those
      // two need to keep an id or the reference dangles and the accessible
      // name silently falls back (or is lost). `id` is inert here: no tag in
      // SVG_TAGS can reference one (<use>, <defs> and url() are all excluded),
      // so it cannot become a bypass.
      title: ["id"],
      desc: ["id"],
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
        "dominant-baseline", "font-size", "font-weight"],
    },
  });
}
