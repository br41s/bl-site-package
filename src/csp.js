// The Content-Security-Policy header for every response. One place, one
// string, because it has to agree with what the pages load: Turnstile on the
// contact page (opt-in, allowed unconditionally since the header is set
// before any per-page config is known) and the chat widget (opt-in per
// deploy: config `chat_widget_url`, the Chatwoot origin, which must be allowed
// for its script, its iframe, its API calls and its websocket -- without the
// wss entry the widget loads but never receives a reply).
export function buildCsp({ chatWidgetUrl = "" } = {}) {
  const chat = chatOrigin(chatWidgetUrl);
  const chatWss = chat ? chat.replace(/^https:/, "wss:") : "";
  const add = (value) => (value ? ` ${value}` : "");
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com${add(chat)}`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    // img-src allows Liderpapel's product-image host so hotlinked catalog
    // images aren't silently blocked (see src/sync/liderpapel/mapping.js).
    `img-src 'self' data: blob: https://*.liderpapel.com${add(chat)}`,
    `connect-src 'self' https://openrouter.ai https://challenges.cloudflare.com${add(chat)}${add(chatWss)}`,
    `frame-src https://challenges.cloudflare.com${add(chat)}`,
    "frame-ancestors 'none'",
  ].join("; ");
}

// Only an https origin gets into the header; anything else (empty, a path,
// http, garbage) is ignored rather than risk a malformed policy.
export function chatOrigin(value) {
  const m = /^(https:\/\/[a-z0-9.-]+(?::[0-9]{2,5})?)\/?$/i.exec(String(value || "").trim());
  return m ? m[1].toLowerCase() : "";
}
