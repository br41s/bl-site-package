// The address the rate limiter keys on.
//
// `req.ip` is the peer Express worked out from TRUST_PROXY_HOPS. Behind Cloudflare
// that peer is an edge shared by many visitors, and the visitor is in
// CF-Connecting-IP. Anyone can send that header, so it only counts when the peer
// itself is Cloudflare. Everywhere else (a deploy off Cloudflare, a Plesk host with
// or without TRUST_PROXY_HOPS) the result is plain `req.ip`, so no deploy needs a
// new setting.

import net from "node:net";

// cloudflare.com/ips-v4 and /ips-v6, checked 2026-11-05. A range missing from here
// only puts that edge's visitors back in one shared bucket.
const CLOUDFLARE = new net.BlockList();
for (const range of [
  "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22",
  "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20",
  "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
  "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
  "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32",
  "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32",
]) {
  const [address, bits] = range.split("/");
  CLOUDFLARE.addSubnet(address, Number(bits), net.isIP(address) === 6 ? "ipv6" : "ipv4");
}

// One IPv6 host usually owns a whole /64, so a limiter keyed on the full address
// hands it a fresh bucket per request. The /64 is the unit it can't rotate out of.
function ipv6Slash64(address) {
  const [head, tail = ""] = address.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(":")}::/64`;
}

function cloudflareVisitor(peer, header) {
  const peerFamily = net.isIP(peer);
  if (!peerFamily || !CLOUDFLARE.check(peer, peerFamily === 6 ? "ipv6" : "ipv4")) return null;
  const visitor = (header || "").trim();
  const family = net.isIP(visitor);
  if (!family) return null;
  return family === 6 ? ipv6Slash64(visitor) : visitor;
}

export function clientIp(req) {
  return cloudflareVisitor(req.ip, req.headers["cf-connecting-ip"]) || req.ip;
}
