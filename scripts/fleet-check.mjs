#!/usr/bin/env node
// Fleet drift check for bl-site-package deployments.
//
// Reads fleet/manifest.json and, for every deployment listed there, answers
// two questions: is it up, and is it running the latest released version.
// The deployed version comes from GET /api/site/status, which is
// authenticated — the panel password for each deployment is read from the
// env var named in its `password_env` field, and no credential ever lives in
// this repo. Without the env var the deployment is only checked for
// availability.
//
// A deployment with Turnstile on (src/turnstile.js) refuses a login that has
// not solved the challenge, which a script never can: that is a 400 from
// /api/auth/login, not a wrong password. The server lets first-party
// automation skip that one check — and only that one — when it sends
// X-Automation-Key matching the deployment's RENTAL_AUTOMATION_KEY (see
// src/api/auth.js). A deployment that needs it names the env var holding
// that key in the optional `automation_key_env` field.
//
// "Latest" is the version in main's package.json (fetched from GitHub so a
// stale local checkout cannot report a stale truth; falls back to the local
// package.json offline). CI enforces the version bump on every PR to main,
// so main's package.json is the release truth by construction.
//
// Exit code 0 = whole fleet up to date; 1 = something is down, outdated or
// unreadable — so it can gate a release step exactly like smoke-test.sh.
//
// Usage:
//   FLEET_PASSWORD_SHOROBAN_PROD=... node scripts/fleet-check.mjs
//   (plus FLEET_AUTOMATION_KEY_SHOROBAN_PROD=... where Turnstile is on)

import { readFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const TIMEOUT_MS = 15_000;

const VALID_ROLES = ["reference", "staging", "production"];

// --- manifest ---------------------------------------------------------------

export function validateManifest(manifest) {
  const errors = [];
  if (!Array.isArray(manifest?.deployments) || manifest.deployments.length === 0) {
    return ["deployments must be a non-empty array"];
  }
  const seen = new Set();
  for (const d of manifest.deployments) {
    const where = d?.id ? `deployment "${d.id}"` : "deployment without id";
    for (const field of ["id", "name", "role", "url", "host", "driver", "password_env"]) {
      if (typeof d?.[field] !== "string" || !d[field].trim()) {
        errors.push(`${where}: missing field "${field}"`);
      }
    }
    if (d?.id) {
      if (seen.has(d.id)) errors.push(`duplicate id "${d.id}"`);
      seen.add(d.id);
    }
    if (d?.role && !VALID_ROLES.includes(d.role)) {
      errors.push(`${where}: role "${d.role}" is not one of ${VALID_ROLES.join(", ")}`);
    }
    if (
      d?.automation_key_env !== undefined &&
      (typeof d.automation_key_env !== "string" || !d.automation_key_env.trim())
    ) {
      errors.push(`${where}: "automation_key_env", if present, must be a non-empty string`);
    }
    if (typeof d?.url === "string" && d.url.endsWith("/")) {
      errors.push(`${where}: url must not end in "/"`);
    }
    if (typeof d?.url === "string" && !/^https?:\/\//.test(d.url)) {
      errors.push(`${where}: url must be http(s)`);
    }
  }
  const refs = manifest.deployments.filter((d) => d?.role === "reference");
  if (refs.length !== 1) {
    errors.push(`exactly one deployment must have role "reference" (found ${refs.length})`);
  }
  return errors;
}

export function loadManifest() {
  const manifest = JSON.parse(
    readFileSync(join(ROOT, "fleet/manifest.json"), "utf8"),
  );
  const errors = validateManifest(manifest);
  if (errors.length) {
    throw new Error("fleet/manifest.json inválido:\n  - " + errors.join("\n  - "));
  }
  return manifest;
}

// --- classification ---------------------------------------------------------

// One deployment's verdict. `version` is null when unreadable (down or no
// credentials). A version mismatch in EITHER direction is drift: an instance
// ahead of main means something was deployed outside the release flow, which
// is at least as worth flagging as one running behind.
export function classify({ up, version, latest, hasCredentials }) {
  if (!up) return "down";
  if (!hasCredentials) return "no_credentials";
  if (version === null) return "status_unreadable";
  if (version !== latest) return "outdated";
  return "ok";
}

// --- HTTP -------------------------------------------------------------------

// The error names the step and carries the server's own `error` text: a bare
// "HTTP 400" once hid that a login was being refused by Turnstile, not by a
// wrong password.
async function fetchJson(url, options = {}, step = "") {
  const res = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    let reason = "";
    try {
      reason = (await res.json())?.error || "";
    } catch {}
    const err = new Error(`${step ? step + " " : ""}HTTP ${res.status}${reason ? ` — ${reason}` : ""}`);
    err.status = res.status;
    err.step = step;
    throw err;
  }
  return res.json();
}

// Headers for the panel login. Pure, so it is testable without a network.
export function loginHeaders(d, env = process.env) {
  const headers = { "Content-Type": "application/json" };
  const key = d.automation_key_env ? env[d.automation_key_env] || "" : "";
  if (key) headers["X-Automation-Key"] = key;
  return headers;
}

// What to tell the operator when reading the status failed. A 400 from the
// login with no automation key sent is the Turnstile case, and the fix is an
// env var, not a password — say so.
export function unreadableDetail(err, d, env = process.env) {
  const base = `status ilegible: ${err.message}`;
  const keySent = Boolean(d.automation_key_env && env[d.automation_key_env]);
  if (err.step === "login" && err.status === 400 && !keySent) {
    const hint = d.automation_key_env
      ? `define ${d.automation_key_env}`
      : `añade "automation_key_env" a su entrada en fleet/manifest.json`;
    return `${base.replace(/\.+$/, "")}. ¿Turnstile activo? El login necesita X-Automation-Key: ${hint}`;
  }
  return base;
}

export async function latestVersion(manifest) {
  try {
    const pkg = await fetchJson(manifest.latest_version_url);
    return { version: pkg.version, source: "main" };
  } catch {
    // Offline (or GitHub down): the local checkout is the best truth we have.
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    return { version: pkg.version, source: "checkout local" };
  }
}

async function checkDeployment(d, latest) {
  const password = process.env[d.password_env] || "";
  const result = {
    id: d.id,
    name: d.name,
    url: d.url,
    role: d.role,
    up: false,
    version: null,
    hasCredentials: Boolean(password),
    detail: "",
  };

  // Availability first, credentials or not: the homepage answering is the
  // signal a visitor cares about, and it needs no auth.
  try {
    const res = await fetch(d.url + "/", {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "follow",
    });
    result.up = res.ok;
    if (!res.ok) result.detail = `portada HTTP ${res.status}`;
  } catch (err) {
    result.detail = err.cause?.code || err.name || String(err);
  }

  if (result.up && password) {
    try {
      const { token } = await fetchJson(
        d.url + "/api/auth/login",
        {
          method: "POST",
          headers: loginHeaders(d),
          body: JSON.stringify({ password }),
        },
        "login",
      );
      const status = await fetchJson(
        d.url + "/api/site/status",
        { headers: { Authorization: `Bearer ${token}` } },
        "status",
      );
      result.version = status.version ?? null;
      if (status.last_build_ok === false) {
        result.detail = "el último rebuild falló";
      }
    } catch (err) {
      result.detail = unreadableDetail(err, d);
    }
  }

  result.state = classify({ ...result, latest });
  return result;
}

// --- rollout log --------------------------------------------------------------
//
// fleet/rollout-log.jsonl records when each deployment was first CONFIRMED on
// a given version — not when the deploy button was clicked, which this repo
// has no way to observe for a manual/Plesk driver. One line per
// (deployment, version) pair, ever: a deployment sitting on the same version
// across many runs produces no new lines, so the log grows only on real
// rollouts and stays cheap to read as history.

export function rolloutKey(deploymentId, version) {
  return `${deploymentId}@${version}`;
}

function parseRolloutLines(text) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// Pure so it's testable without touching the filesystem: given this run's
// results and the set of (deployment, version) pairs already on record,
// returns the new entries to append.
export function newRolloutEntries(results, existingKeys, nowIso) {
  return results
    .filter((r) => r.state === "ok" && !existingKeys.has(rolloutKey(r.id, r.version)))
    .map((r) => ({
      deployment_id: r.id,
      version: r.version,
      confirmed_at: nowIso,
      source: "fleet-check",
    }));
}

function recordRollout(results) {
  const path = join(ROOT, "fleet/rollout-log.jsonl");
  let existing = [];
  try {
    existing = parseRolloutLines(readFileSync(path, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  const existingKeys = new Set(
    existing.map((e) => rolloutKey(e.deployment_id, e.version)),
  );
  const entries = newRolloutEntries(results, existingKeys, new Date().toISOString());
  if (entries.length) {
    appendFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
    for (const e of entries) {
      console.log(`📝 rollout registrado: ${e.deployment_id} → v${e.version}`);
    }
  }
  return entries;
}

// --- report -----------------------------------------------------------------

const STATE_LABEL = {
  ok: "✅ al día",
  outdated: "🔺 DESACTUALIZADA",
  down: "❌ CAÍDA",
  status_unreadable: "⚠️  estado ilegible",
  no_credentials: "➖ sin credenciales (solo disponibilidad)",
};

export async function run() {
  const manifest = loadManifest();
  const latest = await latestVersion(manifest);
  console.log(`Última versión publicada: v${latest.version} (${latest.source})\n`);

  const results = await Promise.all(
    manifest.deployments.map((d) => checkDeployment(d, latest.version)),
  );

  for (const r of results) {
    const version = r.version ? `v${r.version}` : "—";
    const detail = r.detail ? `  (${r.detail})` : "";
    console.log(`${STATE_LABEL[r.state]}  ${r.id}  ${version}  ${r.url}${detail}`);
  }

  recordRollout(results);

  const bad = results.filter((r) => ["down", "outdated", "status_unreadable"].includes(r.state));
  if (bad.length) {
    console.log(`\n${bad.length} despliegue(s) requieren atención.`);
    return 1;
  }
  console.log("\nFlota al día.");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err.message);
      process.exit(2);
    },
  );
}
