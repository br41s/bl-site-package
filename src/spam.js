// Content checks for POST /api/contact that run after Turnstile. Ported from
// biglobster (br41s/biglobster, src/spam.js): on 2026-10-01 spam reached that
// site with valid Turnstile tokens (headless browsers, paid solving services),
// so these checks look at what was submitted instead. A submission that fails
// one gets the same success response as a real one but is neither stored nor
// emailed, so the bot operator has no signal to tune the script against.

// Name of the off-screen field web/site.js injects into the contact form.
// A person never sees it; form-filling bots fill every input they find.
export const HONEYPOT_FIELD = "website";

export function isHoneypotFilled(body) {
  return typeof body[HONEYPOT_FIELD] === "string" && body[HONEYPOT_FIELD].trim() !== "";
}

// Returns the run of letters that looks like the random filler this campaign
// sends ("OYKeUKxWqbn…"), or "" when there is none. Must never reject a real
// customer: short messages, other languages, typos, a pasted identifier like
// "getUserByIdAndTenantId".
// Three signals together, never one: a run of 12+ Latin letters (so Thai,
// Chinese and accented words never qualify) that switches lower→upper case 3+
// times inside itself (real words switch at most once: "WhatsApp") and is
// under 25% vowels (random letters run ~19%; camelCase identifiers, made of
// real words, run 35%+). URLs are stripped first because shortlink and video
// IDs look exactly like this.
export function gibberishRun(text) {
  const withoutUrls = String(text || "").replace(/(?:https?:\/\/|www\.)\S+/gi, " ");
  const runs = withoutUrls.match(/[A-Za-z]{12,}/g) || [];
  return runs.find((run) => {
    const flips = (run.match(/[a-z][A-Z]/g) || []).length;
    const vowels = (run.match(/[aeiou]/gi) || []).length;
    return flips >= 3 && vowels / run.length < 0.25;
  }) || "";
}

export function looksLikeGibberish(text) {
  return gibberishRun(text) !== "";
}

// Returns why a submission is spam, or "" when it should go through. The
// gibberish reason carries the matched run so a false positive is visible in
// the logs instead of silently lost.
export function spamReason({ name, message, raw }) {
  if (isHoneypotFilled(raw)) return "honeypot";
  const run = gibberishRun(message) || gibberishRun(name);
  if (run) return `gibberish "${run}"`;
  return "";
}
