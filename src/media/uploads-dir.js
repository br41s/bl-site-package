import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

// Single source of truth for where uploaded images live, mirroring DB_PATH in
// src/db/database.js: default lives inside the repo (fine on Zeabur, where
// data/ sits on a persistent volume — see src/build/rebuild.js), but on hosts
// where the web docroot is the app root (e.g. Plesk) that default is wiped on
// every deploy, since data/ is gitignored and the deploy resets the working
// tree to match the repo. Point UPLOADS_DIR outside the app root there (see
// RELEASE.md) so uploads survive redeploys the same way the DB already does.
const defaultDir = join(dirname(fileURLToPath(import.meta.url)), "../../data/uploads");
export const UPLOADS_DIR = resolve(process.env.UPLOADS_DIR || defaultDir);

mkdirSync(UPLOADS_DIR, { recursive: true });
