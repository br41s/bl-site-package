// One word of a page title can be emphasised by its author as *word*; the
// Cálida style paints it in the accent colour (DESIGN.md §4). Nothing is
// guessed: a title without the mark renders plain. Everything else that shows
// a title — the <title> tag, Open Graph, the WhatsApp message, /api/knowledge —
// wants the plain text, so both forms come from here and nowhere else.
const MARK = /\*([^*\n]{1,60})\*/;

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// "Sonríe con *tranquilidad*" -> "Sonríe con tranquilidad"
export function stripAccentWord(text) {
  return String(text ?? "").replace(/\*([^*\n]{1,60})\*/g, "$1");
}

// HTML for a heading: the first mark becomes <span class="accent-word">, any
// later one is unwrapped (the spec says one word), and the text is escaped —
// titles are typed in the panel or written by the agent, never trusted markup.
export function renderAccentWord(text) {
  const s = String(text ?? "");
  const m = MARK.exec(s);
  if (!m) return escapeHtml(s);
  const before = s.slice(0, m.index);
  const after = s.slice(m.index + m[0].length);
  return (
    escapeHtml(before) +
    '<span class="accent-word">' +
    escapeHtml(m[1]) +
    "</span>" +
    escapeHtml(stripAccentWord(after))
  );
}
