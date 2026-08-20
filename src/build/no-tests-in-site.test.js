import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

function walk(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(path));
    else if (/\.test\.(js|mjs|cjs)$/.test(entry.name)) found.push(path);
  }
  return found;
}

describe("build safety", () => {
  test("no test file lives under site/", () => {
    // eleventy.config.mjs sets dir.data = "_data", so Eleventy imports every
    // .js under site/_data/ as a data provider. node:test runs a suite the
    // moment it is imported — it does not wait for `node --test`. A test file
    // placed there therefore executes against whatever database the build is
    // pointed at, and its fixtures and teardown run on real data.
    //
    // This is not hypothetical. A test with `beforeEach(() => db.exec("DELETE
    // FROM products"))` sat in site/_data/ during development and one
    // `npx eleventy` run took a 14,487-product catalogue down to a single row.
    // On a customer deploy every rebuild would have done the same.
    //
    // Tests for site/_data/* belong in src/ and import across. Cheap rule,
    // catastrophic to forget.
    const offenders = walk(join(root, "site")).map((p) => relative(root, p));

    assert.deepEqual(
      offenders,
      [],
      `Test files under site/ are executed by every Eleventy build:\n  ${offenders.join("\n  ")}`,
    );
  });
});
