import { resolvesOnDisk } from "./api/redirects.js";

// Every built page answers at two addresses: /productos/x and /productos/x.html
// (`express.static` with `extensions: ["html"]`). The canonical, the sitemap and
// every internal link use the clean one, but Google also crawls the twin and
// reported ~21,000 of them as "alternate page with proper canonical". One 301
// from the twin to the clean address makes each page a single URL.
// `exists` is injected so the test needs no built site.
export function cleanUrlHandler({ exists = resolvesOnDisk } = {}) {
  return function cleanUrls(req, res, next) {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    const [path, query] = req.originalUrl.split("?");
    if (!path.endsWith(".html") || path === "/404.html") return next();
    // Same-origin paths only: `exists` ignores leading slashes, so `//productos/x.html`
    // would pass it and `Location: //productos/x` reads as a host to a browser.
    if (path.startsWith("//") || path.includes("\\") || !exists(path)) return next();
    const clean = path.replace(/\/index\.html$/, "/").replace(/\.html$/, "");
    res.redirect(301, query === undefined ? clean : `${clean}?${query}`);
  };
}
