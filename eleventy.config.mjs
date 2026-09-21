// bl-site-package — Eleventy config
// Input: site/ (Nunjucks templates). Data: site/_data/* reads live SQLite
// content at build time (config table + articles), not static files — the
// customer panel/chat agent still writes to the DB; every write schedules a
// rebuild (see src/build/rebuild.js) so this stays in sync.
// Output: _site/ (served by Express via express.static, see src/server.js) —
// a symlink to the build slot src/build/rebuild.js last completed.

import tableScroll from "./lib/table-scroll.mjs";

export default function (eleventyConfig) {
  // Envuelve cada <table> en un contenedor con scroll propio. Una tabla no
  // baja de su min-content, asi que una tabla ancha en el cuerpo de un
  // articulo empujaba el documento entero fuera de la pantalla en movil. El
  // cuerpo es HTML de cliente que sale de la DB, asi que este es el unico
  // sitio donde se puede corregir. Ver la cabecera de lib/table-scroll.mjs.
  eleventyConfig.addPlugin(tableScroll);

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

  // No dir.output on purpose. A value here overrides the output directory a
  // programmatic caller passes to `new Eleventy(input, output)`, and
  // src/build/rebuild.js builds each run into a slot (_site.a / _site.b) that
  // it then points _site at. Left unset, the CLI (`npm run build`) falls back
  // to Eleventy's default of _site — the same directory as before.
  return {
    dir: {
      input: "site",
      includes: "_includes",
      data: "_data",
    },
  };
}
