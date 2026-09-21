// Entry point of the build process spawned by rebuild.js — one Eleventy build
// of site/ into _site/, then exit. Deliberately the same programmatic call
// rebuild.js used to make in-process, so the two are interchangeable; only
// the process boundary is new. See rebuild.js for why there is one.
//
// Exit status is the whole contract: 0 when _site/ was written, 1 when it was
// not. The error itself is printed here, because the parent only inherits
// this process's stderr and never sees the exception.
//
// Runs with the parent's environment, which is what makes it render the same
// database: site/_data/* opens DB_PATH on import, exactly as `npm run build`
// does.

import Eleventy from "@11ty/eleventy";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

try {
  const elev = new Eleventy(join(root, "site"), join(root, "_site"), {
    configPath: join(root, "eleventy.config.mjs"),
    quietMode: true,
  });
  await elev.write();
} catch (err) {
  console.error("[BUILD] Eleventy rebuild failed:", err.message);
  process.exit(1);
}
