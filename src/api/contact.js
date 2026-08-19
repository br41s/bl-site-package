import { Router } from "express";
import db from "../db/database.js";
import { requireAuth } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rateLimit.js";
import {
  getMailSettings,
  isSmtpConfigured,
  isNotifyEmailConfigured,
  sendMail,
  recordContactEmailResult,
} from "../mail/mailer.js";
import { isTurnstileConfigured, verifyTurnstileToken } from "../turnstile.js";

const router = Router();

// Public endpoint: cap volume to blunt spam/DB-flooding.
const contactLimiter = rateLimit({ windowMs: 60 * 1000, max: 10 });

const MAX_NAME = 200;
const MAX_EMAIL = 200;
const MAX_MESSAGE = 5000;

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// GET /api/contact — inbox del panel
router.get("/", requireAuth, (req, res) => {
  const messages = db
    .prepare(
      "SELECT id, name, email, message, created_at FROM contact_messages ORDER BY datetime(created_at) DESC, id DESC",
    )
    .all();

  res.json({ messages });
});

// POST /api/contact — formulario público
router.post("/", contactLimiter, async (req, res) => {
  const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
  const email = typeof req.body.email === "string" ? req.body.email.trim() : "";
  const message =
    typeof req.body.message === "string" ? req.body.message.trim() : "";

  if (!name || !email || !message) {
    return res
      .status(400)
      .json({ error: "name, email y message son obligatorios" });
  }

  if (
    name.length > MAX_NAME ||
    email.length > MAX_EMAIL ||
    message.length > MAX_MESSAGE
  ) {
    return res.status(400).json({ error: "Uno de los campos es demasiado largo" });
  }

  // Turnstile is opt-in (see src/turnstile.js): an instance with no keys
  // configured skips this block entirely, so the form keeps working exactly
  // as before on a deploy that hasn't set it up.
  if (isTurnstileConfigured()) {
    const turnstileToken =
      typeof req.body.turnstile_token === "string" ? req.body.turnstile_token : "";
    const verified = await verifyTurnstileToken(turnstileToken);
    if (!verified) {
      return res
        .status(400)
        .json({ error: "No se pudo verificar que no eres un robot. Inténtalo de nuevo." });
    }
  }

  db.prepare(
    "INSERT INTO contact_messages (name, email, message) VALUES (?, ?, ?)",
  ).run(name, email, message);

  const settings = getMailSettings();

  if (isSmtpConfigured(settings) && isNotifyEmailConfigured(settings)) {
    try {
      await sendMail(
        {
          from: `"${name}" <${settings.user}>`,
          to: settings.notifyEmail,
          subject: `Nuevo mensaje de contacto de ${name}`,
          text: `Nombre: ${name}\nEmail: ${email}\n\nMensaje:\n${message}`,
          html: `<p><strong>Nombre:</strong> ${escapeHtml(name)}</p><p><strong>Email:</strong> ${escapeHtml(email)}</p><hr><p>${escapeHtml(message).replace(/\n/g, "<br>")}</p>`,
        },
        settings,
      );
      recordContactEmailResult(true);
    } catch (err) {
      // The visitor still gets {success:true}: the message is already stored,
      // and the client's SMTP problems are not theirs to see. The failure is
      // recorded so GET /api/site/status can report it — before that existed,
      // a silently broken mailer only showed up in the container logs.
      console.error("Error enviando email de notificación:", err.message);
      recordContactEmailResult(false, err);
    }
  }

  res.json({ success: true });
});

export default router;
