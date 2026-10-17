import { splitBlocks, innerOf, textOf } from "./html-blocks.js";

// Turns the `###` blocks of a page body into cards, at build time, for the
// Cálida style (DESIGN.md §5.5, §5.8, slice 2). Input is the sanitized HTML
// of page_servicios_desc / page_quienes_desc (formatContent output); the
// Markdown the customer or the agent writes does not change, and Clásico
// never calls this — site/_data/site.js runs it only when site.calida.
//
// Every <h3> starts a card that takes the content up to the next <h3> or
// <h2>; an <h2> ends the run of cards. Everything else stays prose, in place:
// the body becomes a sequence of segments, prose | cards | prose | cards…, so
// an intro above the cards and a closing paragraph below both keep their
// position. The first <img> of a card's content becomes the card's media
// (one photo per team member on Quiénes somos).
//
// Run renderFaqAccordions() first: the FAQ block's own `###` questions are
// then inside <details> and cannot be mistaken for services.
//
// Returns { segments, cards }: `segments` is [{ html }] for prose or
// [{ cards: [...] }] for a run of cards, in order; `cards` is every card,
// flattened, for the home teaser. A body with no <h3> yields one prose
// segment and no cards, and the template falls back to the plain body.

const IMG_RE = /<img\b[^>]*>/i;
const EMPTY_P_RE = /<p\b[^>]*>\s*<\/p>\s*/gi;

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? textOf(m[1]) : "";
}

function makeCard(index, heading, content) {
  let html = content.join("\n");
  let image = null;
  const img = IMG_RE.exec(html);
  if (img) {
    const src = attr(img[0], "src");
    if (src) image = { src, alt: attr(img[0], "alt") };
    html = html.replace(img[0], "").replace(EMPTY_P_RE, "").trim();
  }
  const title = innerOf(heading);
  const plain = textOf(title);
  return {
    index,
    title,
    plainTitle: plain,
    initial: Array.from(plain)[0]?.toUpperCase() ?? "",
    image,
    html,
  };
}

export function splitCards(html) {
  const none = { segments: html ? [{ html }] : [], cards: [] };
  if (!html) return none;
  const blocks = splitBlocks(html);
  if (!blocks || !blocks.some((b) => b.tag === "h3")) return none;

  const segments = [];
  const cards = [];
  let prose = [];
  let run = null; // the cards segment being filled
  let current = null; // { heading, content } of the card being filled

  const flushProse = () => {
    if (prose.length) segments.push({ html: prose.join("\n") });
    prose = [];
  };
  const flushCard = () => {
    if (!current) return;
    const card = makeCard(cards.length + 1, current.heading, current.content);
    cards.push(card);
    run.cards.push(card);
    current = null;
  };

  for (const block of blocks) {
    if (block.tag === "h3") {
      flushCard();
      if (!run) {
        flushProse();
        run = { cards: [] };
        segments.push(run);
      }
      current = { heading: block.html, content: [] };
    } else if (current && block.tag !== "h2") {
      current.content.push(block.html);
    } else {
      flushCard();
      run = null;
      prose.push(block.html);
    }
  }
  flushCard();
  flushProse();
  return { segments, cards };
}
