import nodemailer from "nodemailer";
import { getConfig } from "../db/database.js";

// Single outbound-mail pathway for the whole instance. Both the public contact
// form (src/api/contact.js) and the authenticated notify endpoint
// (src/api/site.js) go through here, so there is one place that knows how SMTP
// is resolved (env var first, panel config second) and one place that can be
// swapped if a client ever needs a different transport.

// Reads the SMTP settings the same way contact.js always has: an env var wins
// over the value the client saved in the panel, so a Zeabur-level override
// doesn't need a panel edit.
export function getMailSettings() {
  return {
    host: process.env.SMTP_HOST || getConfig("smtp_host") || "",
    port: parseInt(process.env.SMTP_PORT || getConfig("smtp_port") || "587", 10),
    user: process.env.SMTP_USER || getConfig("smtp_user") || "",
    pass: process.env.SMTP_PASS || getConfig("smtp_pass") || "",
    notifyEmail: process.env.NOTIFY_EMAIL || getConfig("notify_email") || "",
  };
}

// Presence checks, deliberately split from the values. GET /api/site/status
// reports these two booleans and never the settings themselves — a monitoring
// caller needs to know whether mail can go out, not who it goes to or with
// which password.
export function isSmtpConfigured(settings = getMailSettings()) {
  return !!(settings.host && settings.user && settings.pass);
}

export function isNotifyEmailConfigured(settings = getMailSettings()) {
  return !!settings.notifyEmail;
}

// Sends and throws on failure. Callers decide what to do with the error:
// the contact form swallows it (a visitor must not see the client's SMTP
// problems), the notify endpoint surfaces it (its caller is a monitoring
// agent that exists to find exactly this).
export async function sendMail({ from, to, subject, text, html }, settings = getMailSettings()) {
  const transporter = nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.port === 465,
    auth: { user: settings.user, pass: settings.pass },
  });

  await transporter.sendMail({ from, to, subject, text, html });
}

// Outcome of the most recent contact-form notification attempt.
//
// The contact form answers {success:true} whether or not the e-mail actually
// left the building (a visitor must not be shown the client's SMTP failures),
// which historically made a silently broken mailer invisible from outside the
// instance — leads persisted, notifications vanished. Recording the outcome
// here lets GET /api/site/status expose it.
//
// Error *class* only (nodemailer's code, e.g. "EAUTH"), never the message:
// SMTP servers routinely echo the username back in a rejection string, and
// this field is read by an external caller.
//
// In-memory on purpose. It describes the running process, and persisting it
// would mean a config write on every contact submission — which triggers
// scheduleRebuild(). A restart resets it to null, which reads as "no attempt
// observed yet", not as "healthy".
let lastContactEmail = null;

export function recordContactEmailResult(ok, err) {
  lastContactEmail = {
    at: new Date().toISOString(),
    ok,
    error: ok ? null : err?.code || err?.name || "unknown",
  };
}

export function getLastContactEmail() {
  return lastContactEmail ? { ...lastContactEmail } : null;
}

// Test seam only — the module-level state above would otherwise leak between
// test cases.
export function _resetLastContactEmail() {
  lastContactEmail = null;
}
