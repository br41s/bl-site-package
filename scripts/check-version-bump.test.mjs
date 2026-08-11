import { test } from "node:test";
import assert from "node:assert/strict";
import { isDocsOnly, verdict } from "./check-version-bump.mjs";

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
