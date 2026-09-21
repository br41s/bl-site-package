// Entry point of the build process spawned by rebuild.js — one Eleventy build
// of site/ into the slot directory given as the only argument, then exit.
// Deliberately the same programmatic call rebuild.js used to make in-process,
// so the two are interchangeable; only the process boundary is new. See
// rebuild.js for why there is one, and why the output is a slot rather than
// _site/ itself.
//
// The slot is emptied first, here rather than in the server, so deleting
// ~15,000 files never touches the server's event loop.
//
// Exit status is the whole contract: 0 when the slot was written, 1 when it
// was not. The error itself is printed here, because the parent only inherits
// this process's stderr and never sees the exception.
//
// Runs with the parent's environment, which is what makes it render the same
// database: site/_data/* opens DB_PATH on import, exactly as `npm run build`
// does.

import Eleventy from "@11ty/eleventy";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const outputDir = process.argv[2];
if (!outputDir) {
  console.error("[BUILD] eleventy-child.js needs the output slot as its argument");
  process.exit(1);
}

try {
  rmSync(outputDir, { recursive: true, force: true });
  const elev = new Eleventy(join(root, "site"), outputDir, {
    configPath: join(root, "eleventy.config.mjs"),
    quietMode: true,
  });
  await elev.write();
} catch (err) {
  console.error("[BUILD] Eleventy rebuild failed:", err.message);
  process.exit(1);
}
