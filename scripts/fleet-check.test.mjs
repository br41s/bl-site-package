import { test } from "node:test";
import assert from "node:assert/strict";
import { validateManifest, loadManifest, classify } from "./fleet-check.mjs";

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
