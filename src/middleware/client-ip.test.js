// The limiter's key on every deploy shape, through real Express `trust proxy`.
// The test client plays the proxies, writing X-Forwarded-For as they would.
// 104.16.0.1 stands in for a Cloudflare edge; 203.0.113.x and 2001:db8:: for
// visitors and forgers.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { clientIp } from "./client-ip.js";
import { rateLimit } from "./rateLimit.js";

const EDGE = "104.16.0.1";
const servers = [];

function listen(hops) {
  const app = express();
  if (hops) app.set("trust proxy", hops);
  app.get("/ip", (req, res) => res.json({ ip: clientIp(req) }));
  app.get("/limited", rateLimit({ windowMs: 60_000, max: 1 }), (req, res) => res.json({ ok: true }));
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      servers.push(server);
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

let oneHop, twoHops, noHops;

before(async () => {
  oneHop = await listen(1);
  twoHops = await listen(2);
  noHops = await listen(0);
});

after(() => servers.forEach((server) => server.close()));

async function seenIp(base, headers) {
  const res = await fetch(`${base}/ip`, { headers });
  return (await res.json()).ip;
}

test("Coolify: Cloudflare, then Traefik. The visitor, not the edge", async () => {
  const headers = { "X-Forwarded-For": EDGE, "CF-Connecting-IP": "203.0.113.1" };
  assert.equal(await seenIp(oneHop, headers), "203.0.113.1");
});

test("two visitors on one edge do not share a bucket", async () => {
  const hit = (visitor) =>
    fetch(`${oneHop}/limited`, { headers: { "X-Forwarded-For": EDGE, "CF-Connecting-IP": visitor } });
  assert.equal((await hit("203.0.113.10")).status, 200);
  assert.equal((await hit("203.0.113.11")).status, 200);
  assert.equal((await hit("203.0.113.10")).status, 429);
});

test("a direct request rotating the header stays in one bucket", async () => {
  const hit = (forged) =>
    fetch(`${oneHop}/limited`, { headers: { "X-Forwarded-For": "198.51.100.20", "CF-Connecting-IP": forged } });
  assert.equal((await hit("203.0.113.21")).status, 200);
  assert.equal((await hit("203.0.113.22")).status, 429);
});

test("a Cloudflare Worker rotating the header stays in one bucket", async () => {
  const hit = (forged) =>
    fetch(`${oneHop}/limited`, {
      headers: { "X-Forwarded-For": "104.16.0.2", "CF-Connecting-IP": forged, "CF-Worker": "attacker.example" },
    });
  assert.equal((await hit("203.0.113.31")).status, 200);
  assert.equal((await hit("203.0.113.32")).status, 429);
});

test("prepending a Cloudflare address to X-Forwarded-For does not unlock the header", async () => {
  const headers = { "X-Forwarded-For": `${EDGE}, 198.51.100.9`, "CF-Connecting-IP": "203.0.113.1" };
  assert.equal(await seenIp(oneHop, headers), "198.51.100.9");
});

test("a deploy off Cloudflare keeps req.ip", async () => {
  assert.equal(await seenIp(oneHop, { "X-Forwarded-For": "198.51.100.9" }), "198.51.100.9");
});

test("an edge with a missing or invalid header stays on the edge", async () => {
  assert.equal(await seenIp(oneHop, { "X-Forwarded-For": EDGE }), EDGE);
  assert.equal(await seenIp(oneHop, { "X-Forwarded-For": EDGE, "CF-Connecting-IP": "nonsense" }), EDGE);
});

test("Plesk without TRUST_PROXY_HOPS: the header is ignored, as before", async () => {
  const headers = { "X-Forwarded-For": EDGE, "CF-Connecting-IP": "203.0.113.1" };
  assert.equal(await seenIp(noHops, headers), "127.0.0.1");
});

test("Plesk behind Cloudflare with one hop counted: Cloudflare's edge, then the visitor", async () => {
  const headers = { "X-Forwarded-For": EDGE, "CF-Connecting-IP": "203.0.113.1" };
  assert.equal(await seenIp(oneHop, headers), "203.0.113.1");
});

test("Plesk behind Cloudflare with both hops counted: req.ip is already the visitor", async () => {
  const headers = { "X-Forwarded-For": `203.0.113.1, ${EDGE}`, "CF-Connecting-IP": "203.0.113.99" };
  assert.equal(await seenIp(twoHops, headers), "203.0.113.1");
});

test("a socket without an address (Passenger) does not throw", () => {
  assert.equal(clientIp({ ip: undefined, headers: { "cf-connecting-ip": "203.0.113.1" } }), undefined);
});

test("a Cloudflare peer written as IPv4-mapped IPv6 is still Cloudflare", () => {
  const req = { ip: `::ffff:${EDGE}`, headers: { "cf-connecting-ip": "203.0.113.1" } };
  assert.equal(clientIp(req), "203.0.113.1");
});

test("IPv6 visitors collapse to their /64, however the address is written", () => {
  const key = (ip) => clientIp({ ip: EDGE, headers: { "cf-connecting-ip": ip } });
  assert.equal(key("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), "2001:db8:1:2::/64");
  assert.equal(key("2001:0DB8:0001:0002::1"), "2001:db8:1:2::/64");
  assert.equal(key("2001:db8::1"), "2001:db8:0:0::/64");
  assert.notEqual(key("2001:db8:1:2::1"), key("2001:db8:1:3::1"));
});
