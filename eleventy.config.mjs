// bl-site-package — Eleventy config
// Input: site/ (Nunjucks templates). Data: site/_data/* reads live SQLite
// content at build time (config table + articles), not static files — the
// customer panel/chat agent still writes to the DB; every write schedules a
// rebuild (see src/build/rebuild.js) so this stays in sync.
// Output: _site/ (served by Express via express.static, see src/server.js).

export default function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy({ "web/style.css": "style.css" });
  eleventyConfig.addPassthroughCopy({ "web/site.js": "site.js" });
  eleventyConfig.addPassthroughCopy({ "web/cart.js": "cart.js" });
  eleventyConfig.addPassthroughCopy({ "web/img": "img" });

  // Builds an absolute canonical URL from a page path and the configured
  // site_url. Normalizes the served form (drops "index.html" and the ".html"
  // extension) so canonical/og:url/sitemap all agree on one clean URL and
  // duplicate-content dilution between /x and /x.html is avoided. Returns the
  // bare path when no base is configured (site_url unset).
  eleventyConfig.addFilter("absoluteUrl", (path, base) => {
    const clean = String(path).replace(/index\.html$/, "").replace(/\.html$/, "");
    if (!base) return clean;
    return String(base).replace(/\/+$/, "") + clean;
  });

  // Serializes a JSON-LD object for a <script type="application/ld+json"> block.
  // Escapes "<" as < so a stray "</script>" (or any "<") inside a value
  // can't break out of the script element — the standard XSS-safe way to inline
  // JSON in HTML. Templates emit `{{ obj | jsonLd | safe }}`.
  eleventyConfig.addFilter("jsonLd", (obj) =>
    JSON.stringify(obj).replace(/</g, "\\u003c"),
  );

  return {
    dir: {
      input: "site",
      output: "_site",
      includes: "_includes",
      data: "_data",
    },
  };
}
