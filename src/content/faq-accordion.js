import { FAQ_HEADING_TEXT } from "./structured-data.js";
import { splitBlocks, innerOf, textOf } from "./html-blocks.js";

// Renders the FAQ block of a page body as accordions, at build time, for the
// Cálida style (DESIGN.md §5.8, slice 2). The block is the one buildFaqLd()
// already reads for the FAQPage data: a heading naming the FAQ, then each
// question as an <h3> with its answer beneath, up to the next <h2>. Each
// question becomes <details class="c-faq"><summary>…</summary>…</details>.
//
// Input is the sanitized HTML (formatContent output), and the output adds
// exactly two tags the sanitizer does not allow — details and summary — plus
// one wrapper div, all written here with fixed attributes. Nothing an author
// types can reach them: a <details> in the Markdown is still stripped by
// formatContent, so the XSS boundary is unchanged.
//
// Same threshold as buildFaqLd: fewer than two answered questions and the
// block is left as plain headings, so a page never shows accordions without
// the FAQPage data or the other way round. site/_data/site.js calls this only
// when site.calida; Clásico keeps the headings.

function isFaqHeading(block) {
  return (block.tag === "h2" || block.tag === "h3") && FAQ_HEADING_TEXT.test(textOf(block.html));
}

export function renderFaqAccordions(html) {
  if (!html) return html;
  const blocks = splitBlocks(html);
  if (!blocks) return html;

  const out = [];
  let changed = false;
  for (let i = 0; i < blocks.length; i++) {
    out.push(blocks[i].html);
    if (!isFaqHeading(blocks[i])) continue;

    // The block: prose before the first question, then questions with their
    // answers, until the next <h2> (which the outer loop then emits as is).
    const pieces = [];
    let item = null;
    let j = i + 1;
    for (; j < blocks.length && blocks[j].tag !== "h2"; j++) {
      const b = blocks[j];
      if (b.tag === "h3") {
        item = { raw: b.html, question: innerOf(b.html), answer: [] };
        pieces.push(item);
      } else if (item) {
        item.answer.push(b.html);
      } else {
        pieces.push({ raw: b.html });
      }
    }
    const answered = (p) => p.question && p.answer.join("").trim();
    if (pieces.filter(answered).length < 2) continue;

    for (const p of pieces) {
      out.push(
        answered(p)
          ? `<details class="c-faq"><summary>${p.question}</summary><div class="c-faq-answer">${p.answer.join("\n")}</div></details>`
          : p.raw,
      );
    }
    changed = true;
    i = j - 1;
  }
  return changed ? out.join("\n") : html;
}
