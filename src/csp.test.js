import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCsp, chatOrigin } from "./csp.js";

test("without a chat widget the policy is the historical one", () => {
  const csp = buildCsp();
  assert.equal(
    csp,
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob: https://*.liderpapel.com; connect-src 'self' https://openrouter.ai https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; frame-ancestors 'none'",
  );
});

test("a chat widget origin is allowed for script, frame, img, connect and its websocket", () => {
  const csp = buildCsp({ chatWidgetUrl: "https://chat.example.com/" });
  assert.match(csp, /script-src [^;]*https:\/\/chat\.example\.com/);
  assert.match(csp, /frame-src [^;]*https:\/\/chat\.example\.com/);
  assert.match(csp, /img-src [^;]*https:\/\/chat\.example\.com/);
  assert.match(csp, /connect-src [^;]*https:\/\/chat\.example\.com wss:\/\/chat\.example\.com/);
});

test("only an https origin is accepted; paths, http and junk are ignored", () => {
  assert.equal(chatOrigin("https://Chat.Example.com"), "https://chat.example.com");
  assert.equal(chatOrigin("https://chat.example.com:8443/"), "https://chat.example.com:8443");
  for (const bad of ["", "http://chat.example.com", "https://chat.example.com/widget", "javascript:alert(1)", "https://a b"]) {
    assert.equal(chatOrigin(bad), "", bad);
    assert.equal(buildCsp({ chatWidgetUrl: bad }), buildCsp(), bad);
  }
});
