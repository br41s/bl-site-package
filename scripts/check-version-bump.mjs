#!/usr/bin/env node
// Pre-merge version-bump check for bl-site-package (RELEASE.md step 2).
//
// Every PR that changes code must bump package.json's version before merge,
// or GET /api/site/status reports the same version forever and fleet drift
// detection (scripts/fleet-check.mjs, hermes bl_site_health) goes inert.
// This account has no CI runner, so the gate is this script, run locally as
// part of the release ritual — same rules the old GitHub workflow had:
// doc-only changes (*.md, .github/*) are exempt.
//
// Usage (from the branch about to be merged):
//   node scripts/check-version-bump.mjs
//
// Exit 0 = bump present or not needed; 1 = bump missing; 2 = cannot tell.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const BASE = "origin/main";

export function isDocsOnly(files) {
  return files.every((f) => f.endsWith(".md") || f.startsWith(".github/"));
}

// Pure verdict so the policy is testable without git:
// { ok, reason } — reasons: "no_changes", "docs_only", "bumped", "not_bumped".
export function verdict({ changedFiles, baseVersion, headVersion }) {
  if (changedFiles.length === 0) return { ok: true, reason: "no_changes" };
  if (isDocsOnly(changedFiles)) return { ok: true, reason: "docs_only" };
  if (baseVersion === headVersion) return { ok: false, reason: "not_bumped" };
  return { ok: true, reason: "bumped" };
}

function git(...args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

export function run() {
  try {
    git("fetch", "origin", "main", "--quiet");
  } catch {
    // Offline: compare against the last known origin/main rather than failing.
  }

  let changedFiles, baseVersion;
  try {
    changedFiles = git("diff", "--name-only", `${BASE}...HEAD`)
      .split("\n")
      .filter(Boolean);
    baseVersion = JSON.parse(git("show", `${BASE}:package.json`)).version;
  } catch (err) {
    console.error(`No se pudo comparar con ${BASE}: ${err.message}`);
    return 2;
  }
  const headVersion = JSON.parse(
    readFileSync(join(ROOT, "package.json"), "utf8"),
  ).version;

  const result = verdict({ changedFiles, baseVersion, headVersion });
  const messages = {
    no_changes: "Sin cambios respecto a origin/main.",
    docs_only: "Solo cambian documentos (.md/.github) — no hace falta bump.",
    bumped: `Bump presente: v${baseVersion} → v${headVersion}.`,
    not_bumped:
      `package.json sigue en v${headVersion} con cambios de código respecto a ` +
      `origin/main. Ejecuta 'npm version patch|minor|major' en esta rama ` +
      `antes de mergear — RELEASE.md paso 2.`,
  };
  console.log((result.ok ? "OK  " : "FAIL  ") + messages[result.reason]);
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(run());
}
