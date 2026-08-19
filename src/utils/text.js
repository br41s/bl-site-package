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
