import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderFaqAccordions } from "./faq-accordion.js";
import { splitCards } from "./content-cards.js";
import { formatContent } from "./format-content.js";
import { buildFaqLd } from "./structured-data.js";

// What the customer writes goes through the sanitizer first, exactly as in
// site/_data/site.js.
const render = (md) => renderFaqAccordions(formatContent(md));

const FAQ = `## Preguntas frecuentes

Lo que más nos preguntan.

### ¿Hacéis presupuesto sin compromiso?

Sí, siempre **antes** de tocar la moto.

### ¿Cuánto tarda una revisión?

Normalmente la tienes el mismo día.

- Aceite y filtros: 1 h
- Revisión completa: medio día

## Dónde estamos

En Vigo.`;

describe("renderFaqAccordions", () => {
  test("each question of the FAQ block becomes details/summary, the heading and prose stay", () => {
    const out = render(FAQ);
    assert.ok(out.includes("<h2>Preguntas frecuentes</h2>"), out);
    assert.ok(out.includes("<p>Lo que más nos preguntan.</p>"), out);
    assert.ok(
      out.includes(
        '<details class="c-faq"><summary>¿Hacéis presupuesto sin compromiso?</summary><div class="c-faq-answer"><p>Sí, siempre <strong>antes</strong> de tocar la moto.</p></div></details>',
      ),
      out,
    );
    assert.ok(out.includes("<summary>¿Cuánto tarda una revisión?</summary>"), out);
    assert.ok(out.includes("<li>Aceite y filtros: 1 h</li>"), out);
    assert.ok(!out.includes("<h3>"), "no question is left as a heading");
  });

  test("the next ## ends the block: what follows is untouched", () => {
    const out = render(FAQ);
    assert.ok(out.endsWith("<h2>Dónde estamos</h2>\n<p>En Vigo.</p>"), out);
  });

  test("agrees with buildFaqLd on the same Markdown: same questions, same count", () => {
    const ld = buildFaqLd(FAQ);
    const out = render(FAQ);
    const summaries = [...out.matchAll(/<summary>(.*?)<\/summary>/g)].map((m) => m[1]);
    assert.deepEqual(summaries, ld.mainEntity.map((q) => q.name));
  });

  test("fewer than two answered questions: left as headings, like buildFaqLd returns null", () => {
    const one = "## FAQ\n\n### ¿Una sola?\n\nSí.";
    assert.equal(render(one), formatContent(one));
    assert.equal(buildFaqLd(one), null);
    const unanswered = "## FAQ\n\n### ¿Una?\n\n### ¿Dos?\n\nSolo esta tiene respuesta.";
    assert.equal(render(unanswered), formatContent(unanswered));
  });

  test("an unanswered question inside a valid block stays a heading", () => {
    const out = render("## FAQ\n\n### ¿A?\n\nSí.\n\n### ¿Sin respuesta?\n\n### ¿B?\n\nTambién.");
    assert.equal([...out.matchAll(/<details/g)].length, 2);
    assert.ok(out.includes("<h3>¿Sin respuesta?</h3>"), out);
  });

  test("an ### FAQ heading works too, and headings that only mention FAQs in passing do not", () => {
    const out = render("### Preguntas y respuestas\n\n### ¿A?\n\nSí.\n\n### ¿B?\n\nNo.");
    assert.equal([...out.matchAll(/<details/g)].length, 2);
    const none = "## Nuestros servicios\n\n### Reparación\n\nTexto.\n\n### Revisión\n\nTexto.";
    assert.equal(render(none), formatContent(none));
  });

  test("a body without an FAQ block is returned unchanged, byte for byte", () => {
    const md = "## Servicios\n\n### Uno\n\nA.\n\n### Dos\n\nB.";
    assert.equal(render(md), formatContent(md));
    assert.equal(renderFaqAccordions(""), "");
  });

  test("adds nothing but the fixed details/summary/answer tags: the rest is the sanitized HTML", () => {
    const sanitized = formatContent(FAQ);
    const out = render(FAQ);
    const stripped = out
      .replace(/<details class="c-faq">|<\/details>|<summary>|<\/summary>|<div class="c-faq-answer">|<\/div>/g, "")
      .replace(/\s+/g, "");
    const expected = sanitized.replace(/<h3>|<\/h3>/g, "").replace(/\s+/g, "");
    assert.equal(stripped, expected);
  });

  test("details and summary typed by an author never reach the page", () => {
    const out = render("## FAQ\n\n### ¿A?\n\n<details open ontoggle=\"alert(1)\"><summary>x</summary>y</details>\n\n### ¿B?\n\nB.");
    assert.ok(!out.includes("ontoggle"), out);
    assert.ok(!out.includes("<details open"), out);
    assert.equal([...out.matchAll(/<details class="c-faq">/g)].length, 2);
  });

  test("run before splitCards, the FAQ questions are not mistaken for cards", () => {
    const md = "### Revisión\n\nA.\n\n### Neumáticos\n\nB.\n\n" + FAQ;
    const { cards } = splitCards(render(md));
    assert.deepEqual(cards.map((c) => c.plainTitle), ["Revisión", "Neumáticos"]);
    // The FAQ block itself is prose after the cards, accordions included.
    assert.ok(cards[1].html.includes("<p>B.</p>") && !cards[1].html.includes("<details"), cards[1].html);
  });
});
