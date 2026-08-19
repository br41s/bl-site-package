import Client from "ssh2-sftp-client";
import { mkdirSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { FILENAME_PREFIXES } from "./mapping.js";

const SCRATCH_DIR = join(process.cwd(), "data", "tmp", "liderpapel");

function resolveFeedFiles(names) {
  const resolved = {};
  for (const [key, prefix] of Object.entries(FILENAME_PREFIXES)) {
    const match = names.find((name) => name.startsWith(prefix));
    if (!match) {
      throw new Error(`No se encontró el fichero del feed para "${prefix}"`);
    }
    resolved[key] = match;
  }
  return resolved;
}

// Downloads the 5 feed files (real Liderpapel JSON, matched by prefix
// regardless of extension — see FILENAME_PREFIXES in mapping.js) into
// data/tmp/liderpapel/ (must live under data/, the only persistent volume on
// deploy) and returns local paths. sftp.fastGet() already streams file-to-
// file without buffering the whole transfer in memory, so this needed no
// rewrite for the large real files (up to ~100MB).
export async function fetchViaSftp({ host, port, username, password, remoteDir = "/" }) {
  mkdirSync(SCRATCH_DIR, { recursive: true });
  const sftp = new Client();
  try {
    await sftp.connect({ host, port, username, password, readyTimeout: 15000 });
    const list = await sftp.list(remoteDir);
    const names = list.filter((item) => item.type === "-").map((item) => item.name);
    const files = resolveFeedFiles(names);

    const paths = {};
    for (const [key, filename] of Object.entries(files)) {
      const remotePath = `${remoteDir.replace(/\/$/, "")}/${filename}`;
      const localPath = join(SCRATCH_DIR, filename);
      await sftp.fastGet(remotePath, localPath);
      paths[key] = localPath;
    }
    return paths;
  } finally {
    await sftp.end();
  }
}

// No-network mode: resolves the 7 expected filenames inside a local
// directory. Used for fixture-based verification without real credentials.
export function fetchFromLocalDir(dirPath) {
  const names = readdirSync(dirPath);
  const files = resolveFeedFiles(names);
  const paths = {};
  for (const [key, filename] of Object.entries(files)) {
    paths[key] = join(dirPath, filename);
  }
  return paths;
}

export function cleanupScratch() {
  rmSync(SCRATCH_DIR, { recursive: true, force: true });
}
