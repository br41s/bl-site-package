import { test } from "node:test";
import assert from "node:assert/strict";
import { isDocsOnly, verdict, compareVersions, parseVersion } from "./check-version-bump.mjs";

test("docs-only detection", () => {
  assert.equal(isDocsOnly(["RELEASE.md", "fleet/README.md"]), true);
  assert.equal(isDocsOnly([".github/workflows/x.yml"]), true);
  assert.equal(isDocsOnly(["RELEASE.md", "src/server.js"]), false);
});

test("verdict: code change without bump fails", () => {
  const r = verdict({
    changedFiles: ["src/server.js"],
    baseVersion: "1.0.1",
    headVersion: "1.0.1",
  });
  assert.deepEqual(r, { ok: false, reason: "not_bumped" });
});

test("verdict: code change with bump passes", () => {
  const r = verdict({
    changedFiles: ["src/server.js", "RELEASE.md"],
    baseVersion: "1.0.1",
    headVersion: "1.0.2",
  });
  assert.deepEqual(r, { ok: true, reason: "bumped" });
});

test("verdict: docs-only and empty diffs pass without bump", () => {
  assert.equal(
    verdict({ changedFiles: ["DEPLOY.md"], baseVersion: "1.0.1", headVersion: "1.0.1" }).reason,
    "docs_only",
  );
  assert.equal(
    verdict({ changedFiles: [], baseVersion: "1.0.1", headVersion: "1.0.1" }).reason,
    "no_changes",
  );
});


// --- the gate must check the direction, not just that a number changed ------

test("a version below main is refused, not counted as a bump", () => {
  // This happened: a branch cut before main moved on bumped 1.4.1 -> 1.4.2
  // while main was already 1.5.0, and the gate said OK. Merging it would have
  // taken the fleet's reported version backwards and made every deployed
  // instance look out of date to fleet-check and bl_site_health.
  const r = verdict({
    changedFiles: ["src/api/products.js"],
    baseVersion: "1.5.0",
    headVersion: "1.4.2",
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "regressed");
});

test("an ordinary bump still passes", () => {
  assert.equal(
    verdict({ changedFiles: ["src/server.js"], baseVersion: "1.5.0", headVersion: "1.5.1" }).reason,
    "bumped",
  );
});

test("compares numerically, not as text", () => {
  // "1.10.0" < "1.9.0" as strings, which is how this class of bug usually
  // survives a first attempt at fixing it.
  assert.equal(
    verdict({ changedFiles: ["src/server.js"], baseVersion: "1.9.0", headVersion: "1.10.0" }).reason,
    "bumped",
  );
  assert.equal(
    verdict({ changedFiles: ["src/server.js"], baseVersion: "1.10.0", headVersion: "1.9.0" }).reason,
    "regressed",
  );
});

test("a major bump passes and a major regression does not", () => {
  assert.equal(
    verdict({ changedFiles: ["src/server.js"], baseVersion: "1.9.9", headVersion: "2.0.0" }).reason,
    "bumped",
  );
  assert.equal(
    verdict({ changedFiles: ["src/server.js"], baseVersion: "2.0.0", headVersion: "1.9.9" }).reason,
    "regressed",
  );
});

test("an unreadable version is reported rather than ranked", () => {
  const r = verdict({
    changedFiles: ["src/server.js"],
    baseVersion: "1.5.0",
    headVersion: "no-soy-una-version",
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unreadable");
});

test("docs-only still skips the check entirely, whatever the versions", () => {
  assert.equal(
    verdict({ changedFiles: ["README.md"], baseVersion: "1.5.0", headVersion: "1.4.2" }).reason,
    "docs_only",
  );
});

test("version parsing and comparison", () => {
  assert.deepEqual(parseVersion("1.2.3"), [1, 2, 3]);
  assert.deepEqual(parseVersion("v1.2.3"), null, "a leading v is not our format");
  assert.equal(parseVersion("nope"), null);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  assert.equal(compareVersions("1.2.4", "1.2.3"), 1);
  assert.equal(compareVersions("1.2.3", "1.2.4"), -1);
  assert.equal(compareVersions("nope", "1.2.3"), null);
});
