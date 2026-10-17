import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { splitCards } from "./content-cards.js";
import { splitBlocks } from "./html-blocks.js";
import { formatContent } from "./format-content.js";

// What the customer writes goes through the sanitizer first, exactly as in
// site/_data/site.js.
const cardsOf = (md) => splitCards(formatContent(md));

const SERVICES = `Llevamos veinte años cuidando motos en Vigo.

### Revisión *completa*

Aceite, filtros, frenos y neumáticos en el día.

- Presupuesto cerrado
- Te avisamos por WhatsApp

### Neumáticos

Montaje y equilibrado de las principales marcas.

### Pintura

Trabajamos con [Pintumoto](https://pintumoto.example).

Pide cita cuando quieras.`;

describe("splitCards", () => {
  test("each ### block becomes a card; the text before the first one stays prose", () => {
    const { segments, cards } = cardsOf(SERVICES);
    assert.equal(cards.length, 3);
    assert.deepEqual(cards.map((c) => c.plainTitle), ["Revisión completa", "Neumáticos", "Pintura"]);
    assert.deepEqual(cards.map((c) => c.index), [1, 2, 3]);
    // Intro prose, then one run of cards; the closing paragraph belongs to
    // the last card, like any other content under its heading.
    assert.equal(segments.length, 2);
    assert.ok(segments[0].html.includes("veinte años"), segments[0].html);
    assert.equal(segments[1].cards.length, 3);
    assert.ok(cards[2].html.includes("Pide cita"), cards[2].html);
  });

  test("the card title keeps its inline markup and the body keeps lists and links", () => {
    const { cards } = cardsOf(SERVICES);
    assert.equal(cards[0].title, "Revisión <em>completa</em>");
    assert.ok(cards[0].html.includes("<li>Presupuesto cerrado</li>"), cards[0].html);
    assert.ok(cards[2].html.includes('<a href="https://pintumoto.example">Pintumoto</a>'), cards[2].html);
    assert.ok(!cards[0].html.includes("<h3"), "the heading is not repeated in the body");
  });

  test("an ## heading ends the run of cards and starts prose again", () => {
    const { segments, cards } = cardsOf("### Uno\n\nA.\n\n### Dos\n\nB.\n\n## Cómo trabajamos\n\nEn tres pasos.\n\n### Tres\n\nC.");
    assert.deepEqual(cards.map((c) => c.plainTitle), ["Uno", "Dos", "Tres"]);
    assert.equal(segments.length, 3);
    assert.equal(segments[0].cards.length, 2);
    assert.ok(segments[1].html.startsWith("<h2>Cómo trabajamos</h2>"), segments[1].html);
    assert.ok(segments[1].html.includes("En tres pasos"), segments[1].html);
    assert.equal(segments[2].cards.length, 1);
    assert.equal(segments[2].cards[0].index, 3, "numbering runs across the whole page");
  });

  test("the first image of a block becomes the card media and leaves the body", () => {
    const { cards } = cardsOf(
      '### Ana García\n\n<img src="/uploads/ana.webp" alt="Ana, &quot;la jefa&quot;">\n\nMecánica jefe desde 2010.\n\n<img src="/uploads/ana-2.webp" alt="Otra">',
    );
    assert.deepEqual(cards[0].image, { src: "/uploads/ana.webp", alt: 'Ana, "la jefa"' });
    assert.equal(cards[0].initial, "A");
    assert.ok(!cards[0].html.includes("ana.webp"), cards[0].html);
    assert.ok(!/<p>\s*<\/p>/.test(cards[0].html), `empty paragraph left behind: ${cards[0].html}`);
    // Only the first image is media; a second one stays in the body.
    assert.ok(cards[0].html.includes("ana-2.webp"), cards[0].html);
    assert.ok(cards[0].html.includes("Mecánica jefe"), cards[0].html);
  });

  test("a block without an image has no media and an initial for the fallback mark", () => {
    const { cards } = cardsOf("### Ángel\n\nTexto.");
    assert.equal(cards[0].image, null);
    assert.equal(cards[0].initial, "Á");
  });

  test("a body with no ### yields one prose segment and no cards", () => {
    const out = cardsOf("## Servicios\n\nSolo prosa, con **negrita**.");
    assert.equal(out.cards.length, 0);
    assert.equal(out.segments.length, 1);
    assert.equal(out.segments[0].html, formatContent("## Servicios\n\nSolo prosa, con **negrita**."));
  });

  test("empty input yields no segments and no cards", () => {
    assert.deepEqual(splitCards(""), { segments: [], cards: [] });
    assert.deepEqual(splitCards(undefined), { segments: [], cards: [] });
  });

  test("an h3 nested in a blockquote is not a card", () => {
    const { cards } = cardsOf("> ### Cita\n> Texto.\n\nProsa.");
    assert.equal(cards.length, 0);
  });
});

describe("splitBlocks", () => {
  test("splits sanitizer output into top-level blocks, nested tags included", () => {
    const html = formatContent("Intro.\n\n- a\n- b\n\n### T\n\n| a | b |\n| - | - |\n| 1 | 2 |");
    const tags = splitBlocks(html).map((b) => b.tag);
    assert.deepEqual(tags, ["p", "ul", "h3", "table"]);
  });

  test("void and self-closing tags do not change the depth", () => {
    const blocks = splitBlocks('<p>a<br />b</p>\n<p><img src="/uploads/x.webp" alt="" /></p><hr>');
    assert.deepEqual(blocks.map((b) => b.tag), ["p", "p", "hr"]);
  });

  test("unbalanced markup returns null so callers leave the HTML alone", () => {
    assert.equal(splitBlocks("<p>a"), null);
    assert.equal(splitBlocks("a</p>"), null);
  });
});
