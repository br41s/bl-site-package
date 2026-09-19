import { createHash } from "node:crypto";

// Lowercases and strips diacritics (accented vowels, n-tilde, ...) so
// accent-insensitive substring search works regardless of whether the
// stored text or the search term carries accents. \p{Mn} (Unicode
// nonspacing mark) matches the combining marks NFD decomposition splits
// accented characters into, e.g. "í" -> "i" + U+0301.
export function normalizeForSearch(text) {
  return (text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Mn}/gu, "");
}

// Fingerprint of an article body, used to notice a second writer got there
// first (see articles.content_hash in src/db/database.js).
//
// Deliberately hashes the body ALONE and not the title or excerpt: the point
// is "is the prose I based my edit on still the prose that is live", and a
// title fix by the panel should not invalidate a body rewrite that is still
// perfectly applicable. sha256 truncated to 16 hex chars — this detects
// concurrent edits, it does not defend against a forged one, and the column
// is never trusted from a caller anyway.
export function hashContent(content) {
  return createHash("sha256")
    .update(String(content ?? ""), "utf8")
    .digest("hex")
    .slice(0, 16);
}
