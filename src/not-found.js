import { join } from "node:path";

// The 404 page follows the site's style. Eleventy builds site/404.njk through
// base.njk into _site/404.html — the same nav, footer, fonts and tokens as
// every other page, Cálida or Clásico — and this sends it with a 404 status.
// Until a first build exists (the server answers while buildOnStartup() runs,
// and a failed build leaves no _site at all on a fresh instance) web/404.html
// is the fallback: a static page with no nav, because there is no config to
// draw one from. If even that cannot be read, a JSON 404, so a visitor never
// gets an empty reply.
//
// server.js mounts the handler twice: last, as the catch-all, and before the
// static mounts for GET /404 and /404.html. Otherwise express.static would
// serve the built page with a 200 — at /404.html, and through its
// `extensions: ["html"]` option at /404 as well.
export function notFoundHandler({ siteDir, webDir }) {
  const built = join(siteDir, "404.html");
  const fallback = join(webDir, "404.html");
  return function notFound(req, res) {
    res.status(404).sendFile(built, (err) => {
      if (!err || res.headersSent) return;
      res.status(404).sendFile(fallback, (err2) => {
        if (err2 && !res.headersSent) res.status(404).json({ error: "Not found" });
      });
    });
  };
}
