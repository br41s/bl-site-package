import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateManifest,
  loadManifest,
  classify,
  rolloutKey,
  newRolloutEntries,
} from "./fleet-check.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const entry = (over = {}) => ({
  id: "x-prod",
  name: "X",
  customer: "X",
  role: "production",
  url: "https://x.example",
  host: "zeabur",
  driver: "zeabur",
  hermes_profile: "x",
  password_env: "FLEET_PASSWORD_X",
  ...over,
});

const ref = entry({ id: "ref", role: "reference", url: "https://ref.example" });

test("the committed manifest is valid", () => {
  // Makes `npm test` the gate: a typo in fleet/manifest.json fails CI.
  assert.doesNotThrow(() => loadManifest());
});

test("valid manifest passes", () => {
  assert.deepEqual(validateManifest({ deployments: [ref, entry()] }), []);
});

test("empty or missing deployments is rejected", () => {
  assert.equal(validateManifest({}).length, 1);
  assert.equal(validateManifest({ deployments: [] }).length, 1);
});

test("duplicate ids are rejected", () => {
  const errors = validateManifest({ deployments: [ref, entry(), entry()] });
  assert.ok(errors.some((e) => e.includes('duplicate id "x-prod"')));
});

test("trailing slash and bad scheme are rejected", () => {
  const errors = validateManifest({
    deployments: [ref, entry({ url: "https://x.example/" }), entry({ id: "y", url: "ftp://y" })],
  });
  assert.ok(errors.some((e) => e.includes('must not end in "/"')));
  assert.ok(errors.some((e) => e.includes("must be http(s)")));
});

test("missing fields and unknown role are named", () => {
  const errors = validateManifest({
    deployments: [ref, entry({ password_env: "", role: "prod" })],
  });
  assert.ok(errors.some((e) => e.includes('missing field "password_env"')));
  assert.ok(errors.some((e) => e.includes('role "prod"')));
});

test("exactly one reference deployment is required", () => {
  const none = validateManifest({ deployments: [entry()] });
  assert.ok(none.some((e) => e.includes('role "reference" (found 0)')));
  const two = validateManifest({
    deployments: [ref, entry({ id: "ref2", role: "reference" })],
  });
  assert.ok(two.some((e) => e.includes('role "reference" (found 2)')));
});

test("classify: drift states", () => {
  const base = { up: true, hasCredentials: true, latest: "1.2.0" };
  assert.equal(classify({ ...base, version: "1.2.0" }), "ok");
  assert.equal(classify({ ...base, version: "1.1.0" }), "outdated");
  // Ahead of main is drift too: it was deployed outside the release flow.
  assert.equal(classify({ ...base, version: "1.3.0" }), "outdated");
  assert.equal(classify({ ...base, version: null }), "status_unreadable");
  assert.equal(classify({ up: false, version: null, hasCredentials: true, latest: "1.2.0" }), "down");
  assert.equal(classify({ up: true, version: null, hasCredentials: false, latest: "1.2.0" }), "no_credentials");
});

test("rolloutKey pairs deployment and version", () => {
  assert.equal(rolloutKey("shoroban-staging", "1.0.2"), "shoroban-staging@1.0.2");
});

test("newRolloutEntries: only 'ok' results not already on record are logged", () => {
  const results = [
    { id: "a", state: "ok", version: "1.0.2" },
    { id: "b", state: "outdated", version: "1.0.0" }, // never rolled out — not logged
    { id: "c", state: "ok", version: "1.0.2" },
  ];
  const existing = new Set(["c@1.0.2"]); // already recorded on a prior run
  const entries = newRolloutEntries(results, existing, "2026-08-11T00:00:00.000Z");
  assert.deepEqual(entries, [
    {
      deployment_id: "a",
      version: "1.0.2",
      confirmed_at: "2026-08-11T00:00:00.000Z",
      source: "fleet-check",
    },
  ]);
});

test("newRolloutEntries: same version across repeated runs produces nothing new", () => {
  const results = [{ id: "a", state: "ok", version: "1.0.2" }];
  const existing = new Set(["a@1.0.2"]);
  assert.deepEqual(newRolloutEntries(results, existing, "2026-08-11T00:00:00.000Z"), []);
});

test("rollout log, if present, is well-formed JSONL", () => {
  // Tolerates a missing file (nothing has ever been confirmed via fleet-check
  // in this checkout/CI) but validates shape once entries exist, so a
  // malformed line — e.g. a hand edit — fails npm test.
  let text;
  try {
    text = readFileSync(join(ROOT, "fleet/rollout-log.jsonl"), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return;
    throw err;
  }
  const lines = text.split("\n").filter(Boolean);
  for (const line of lines) {
    const entry = JSON.parse(line);
    assert.equal(typeof entry.deployment_id, "string");
    assert.equal(typeof entry.version, "string");
    assert.ok(!Number.isNaN(Date.parse(entry.confirmed_at)), "confirmed_at must be a valid date");
    assert.equal(typeof entry.source, "string");
  }
});
