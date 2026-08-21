// Minimal in-memory fixed-window rate limiter.
//
// Deliberately dependency-free and keyed on `req.ip`. This package runs one
// container + one SQLite file per client, so an in-process counter is enough;
// if a client ever scales to multiple instances, swap this for a shared-store
// limiter (e.g. express-rate-limit backed by Redis).
//
// NOTE on `req.ip` behind a proxy: Express `trust proxy` is off unless the
// deploy sets TRUST_PROXY_HOPS (see src/server.js). Without it, `req.ip` is
// the proxy peer, so every visitor behind that proxy shares one bucket —
// on a deploy target where that env var isn't set, one bot hammering an
// endpoint fills the same bucket a legitimate visitor is using and locks
// them out too, not just itself.

const buckets = new Map(); // key -> { count, resetAt }

export function rateLimit({ windowMs, max, message }) {
  return (req, res, next) => {
    const now = Date.now();
    const key = `${req.baseUrl}${req.path}:${req.ip}`;

    let bucket = buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;

    if (bucket.count > max) {
      res.setHeader("Retry-After", String(Math.ceil((bucket.resetAt - now) / 1000)));
      return res
        .status(429)
        .json({ error: message || "Demasiadas peticiones, inténtalo más tarde." });
    }

    // Opportunistic cleanup so the map can't grow unbounded across many IPs.
    if (buckets.size > 5000) {
      for (const [k, v] of buckets) if (now >= v.resetAt) buckets.delete(k);
    }

    next();
  };
}
