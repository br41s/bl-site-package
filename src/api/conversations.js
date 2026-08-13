import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";

// Server-side proxy to the central Chatwoot instance for the panel's
// WhatsApp inbox. The browser never receives CHATWOOT_API_TOKEN -- every
// call here is authenticated to the panel via the existing JWT
// (requireAuth) and to Chatwoot via this server's own token.
//
// Off by default: any route below responds 404 if Chatwoot isn't
// configured for this deployment, same pattern as /api/knowledge.
const router = Router();

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function chatwootConfigured() {
  return Boolean(
    process.env.CHATWOOT_BASE_URL &&
      process.env.CHATWOOT_ACCOUNT_ID &&
      process.env.CHATWOOT_API_TOKEN,
  );
}

function requireChatwootConfigured(req, res, next) {
  if (!chatwootConfigured()) return res.status(404).json({ error: "not_found" });
  next();
}

async function chatwootRequest(path, { method = "GET", body } = {}) {
  const base = process.env.CHATWOOT_BASE_URL.replace(/\/+$/, "");
  const accountId = process.env.CHATWOOT_ACCOUNT_ID;
  const res = await fetch(`${base}/api/v1/accounts/${accountId}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      api_access_token: process.env.CHATWOOT_API_TOKEN,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Chatwoot ${method} ${path} failed: ${res.status} ${text.slice(0, 200)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// "+34600111222" -> "+34 ••• ••• 222". The panel list/transcript views
// must never show a full phone number.
export function maskPhone(phone) {
  if (typeof phone !== "string" || !phone) return "(sin número)";
  const digits = phone.replace(/[^\d+]/g, "");
  const cc = digits.startsWith("+") ? digits.slice(0, 3) : digits.slice(0, 2);
  const last3 = digits.slice(-3);
  return `${cc} ••• ••• ${last3}`;
}

// Meta only allows free-form (non-template) outbound messages within 24h
// of the visitor's last inbound message. Chatwoot's `created_at` on a
// message is a unix timestamp in seconds -- verify against the live
// instance before relying on this (flagged, like the bot service's
// chatwoot.js, as unconfirmed against a running Chatwoot rather than
// just its docs).
export function computeWindowState(messages, nowMs = Date.now()) {
  const inbound = (messages || [])
    .filter((m) => m.message_type === 0 || m.message_type === "incoming")
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  const last = inbound[0];
  if (!last) return { withinWindow: false, msRemaining: 0, lastInboundAt: null };
  const createdMs = Number(last.created_at) * 1000;
  const deadline = createdMs + ONE_DAY_MS;
  const msRemaining = Math.max(0, deadline - nowMs);
  return {
    withinWindow: msRemaining > 0,
    msRemaining,
    lastInboundAt: new Date(createdMs).toISOString(),
  };
}

// Maps the panel's 4 filters onto Chatwoot conversation state. "needs
// attention" is the subset of open (human-owned) conversations the bot
// service labelled on escalation (see hermes-sandbox
// scripts/whatsapp-lead-bot/src/webhook.js) -- "human" is the broader
// view of everything currently human-owned, including ones already being
// worked.
const STATUS_FILTERS = {
  bot: { status: "pending" },
  human: { status: "open" },
  needs_attention: { status: "open", label: "needs-attention" },
  resolved: { status: "resolved" },
};

// GET /api/conversations?filter=needs_attention|bot|human|resolved
router.get("/", requireAuth, requireChatwootConfigured, async (req, res) => {
  const filter = STATUS_FILTERS[req.query.filter] || null;
  try {
    const qs = new URLSearchParams();
    if (filter) qs.set("status", filter.status);
    if (filter?.label) qs.set("labels", filter.label);
    const data = await chatwootRequest(`/conversations?${qs.toString()}`);
    const conversations = (data?.data?.payload || data?.payload || []).map((c) => ({
      id: c.id,
      status: c.status,
      visitorName: c.meta?.sender?.name || null,
      visitorPhone: maskPhone(c.meta?.sender?.phone_number),
      leadNeed: c.custom_attributes?.lead_need || null,
      escalationReason: c.custom_attributes?.escalation_reason || null,
      unreadCount: c.unread_count || 0,
      lastActivityAt: c.last_activity_at
        ? new Date(c.last_activity_at * 1000).toISOString()
        : null,
    }));
    res.json({ conversations });
  } catch (err) {
    console.error("Chatwoot conversations list error:", err.message);
    res.status(502).json({ error: "chatwoot_unavailable" });
  }
});

// GET /api/conversations/:id — detail + transcript + window state
router.get("/:id", requireAuth, requireChatwootConfigured, async (req, res) => {
  try {
    const [conversation, messages] = await Promise.all([
      chatwootRequest(`/conversations/${req.params.id}`),
      chatwootRequest(`/conversations/${req.params.id}/messages`),
    ]);
    const messageList = Array.isArray(messages) ? messages : messages?.payload || [];
    res.json({
      id: conversation.id,
      status: conversation.status,
      visitorName: conversation.meta?.sender?.name || null,
      visitorPhone: maskPhone(conversation.meta?.sender?.phone_number),
      leadName: conversation.custom_attributes?.lead_name || null,
      leadEmail: conversation.custom_attributes?.lead_email || null,
      leadNeed: conversation.custom_attributes?.lead_need || null,
      escalationReason: conversation.custom_attributes?.escalation_reason || null,
      window: computeWindowState(messageList),
      messages: messageList.map((m) => ({
        id: m.id,
        direction: m.message_type === 0 || m.message_type === "incoming" ? "in" : "out",
        senderType: m.sender?.type || (m.message_type === 1 ? "agent" : "contact"),
        content: m.content || "",
        createdAt: m.created_at ? new Date(m.created_at * 1000).toISOString() : null,
        status: m.status || null, // Chatwoot delivery status: sent/delivered/read/failed
      })),
    });
  } catch (err) {
    console.error("Chatwoot conversation detail error:", err.message);
    res.status(502).json({ error: "chatwoot_unavailable" });
  }
});

async function setStatus(req, res, status) {
  try {
    await chatwootRequest(`/conversations/${req.params.id}/toggle_status`, {
      method: "POST",
      body: { status },
    });
    res.json({ success: true });
  } catch (err) {
    console.error(`Chatwoot toggle_status(${status}) error:`, err.message);
    res.status(502).json({ error: "chatwoot_unavailable" });
  }
}

// POST /api/conversations/:id/takeover — human takes control (bot stops)
router.post("/:id/takeover", requireAuth, requireChatwootConfigured, (req, res) =>
  setStatus(req, res, "open"),
);

// POST /api/conversations/:id/release — hand back to the bot
router.post("/:id/release", requireAuth, requireChatwootConfigured, (req, res) =>
  setStatus(req, res, "pending"),
);

// POST /api/conversations/:id/resolve — close the conversation
router.post("/:id/resolve", requireAuth, requireChatwootConfigured, (req, res) =>
  setStatus(req, res, "resolved"),
);

const MAX_REPLY_CHARS = 4000;

// POST /api/conversations/:id/messages — { content }
// The recipient always comes from the stored conversation id in the URL;
// there is no field anywhere on this route the caller can use to choose
// a different destination.
router.post("/:id/messages", requireAuth, requireChatwootConfigured, async (req, res) => {
  const content = typeof req.body?.content === "string" ? req.body.content.trim() : "";
  if (!content) {
    return res.status(400).json({ error: "invalid_body", message: "content es obligatorio" });
  }
  if (content.length > MAX_REPLY_CHARS) {
    return res.status(400).json({ error: "invalid_body", message: "Mensaje demasiado largo" });
  }

  try {
    // Re-check server-side: the composer only being enabled client-side
    // when status is "open" is a UX nicety, not a security boundary. A
    // conversation that reverted to bot ownership (or was resolved)
    // between page load and send must reject the send here.
    const [conversation, messages] = await Promise.all([
      chatwootRequest(`/conversations/${req.params.id}`),
      chatwootRequest(`/conversations/${req.params.id}/messages`),
    ]);
    if (conversation.status !== "open") {
      return res.status(409).json({
        error: "not_human_owned",
        message: "Esta conversación no está bajo control humano en este momento",
      });
    }
    const messageList = Array.isArray(messages) ? messages : messages?.payload || [];
    const window = computeWindowState(messageList);
    if (!window.withinWindow) {
      return res.status(409).json({
        error: "window_lapsed",
        message:
          "Han pasado más de 24 horas desde el último mensaje del cliente. WhatsApp no permite responder libremente fuera de ese plazo.",
      });
    }

    await chatwootRequest(`/conversations/${req.params.id}/messages`, {
      method: "POST",
      body: { content, message_type: "outgoing" },
    });
    res.json({ success: true });
  } catch (err) {
    console.error("Chatwoot send message error:", err.message);
    res.status(502).json({ error: "chatwoot_unavailable" });
  }
});

export default router;
