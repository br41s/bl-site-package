import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { formatContent } from "./format-content.js";

// The allowlist in format-content.js IS the XSS boundary for all article and
// page content: anything an agent or a panel user writes goes through it. A
// refactor that accidentally admits `href`, `style`, or a script-bearing
// element would create a silent injection sink, so each excluded vector gets
// its own test rather than relying on the comments to hold the line.

describe("formatContent — dangerous SVG vectors are stripped", () => {
  // Each case is [name, markdown input, substring that must NOT appear].
  // Checking for the payload rather than the tag catches the case where the
  // tag is dropped but its contents get re-emitted as text.
  const vectors = [
    ["inline event handler on svg", '<svg viewBox="0 0 10 10" onload="alert(1)"></svg>', "alert(1)"],
    ["inline event handler on a shape", '<svg viewBox="0 0 10 10"><rect onclick="alert(1)" x="0"/></svg>', "alert(1)"],
    ["script element inside svg", '<svg viewBox="0 0 10 10"><script>alert(1)</script></svg>', "alert(1)"],
    ["style element inside svg", '<svg viewBox="0 0 10 10"><style>*{x:y}</style></svg>', "<style"],
    ["foreignObject re-entering HTML", '<svg viewBox="0 0 10 10"><foreignObject><img src=x onerror="alert(1)"></foreignObject></svg>', "onerror"],
    ["use with a data: reference", '<svg viewBox="0 0 10 10"><use href="data:image/svg+xml;base64,PHN2Zz4="/></svg>', "data:image"],
    ["use with a fragment reference", '<svg viewBox="0 0 10 10"><use href="#evil"/></svg>', "#evil"],
    ["style attribute with a url()", '<svg viewBox="0 0 10 10"><rect style="background:url(javascript:alert(1))" x="0"/></svg>', "javascript:"],
    ["image element fetching an external URL", '<svg viewBox="0 0 10 10"><image href="https://evil.tld/track.png"/></svg>', "evil.tld"],
    ["xlink:href on an image element", '<svg viewBox="0 0 10 10"><image xlink:href="https://evil.tld/x.png"/></svg>', "evil.tld"],
    ["SMIL animate", '<svg viewBox="0 0 10 10"><animate attributeName="x" to="9"/></svg>', "<animate"],
  ];

  for (const [name, input, forbidden] of vectors) {
    test(name, () => {
      const out = formatContent(input);
      assert.ok(
        !out.includes(forbidden),
        `expected ${JSON.stringify(forbidden)} to be stripped, got: ${out}`,
      );
    });
  }

  test("no event-handler attribute of any name survives", () => {
    const out = formatContent(
      '<svg viewBox="0 0 10 10" onload="a()" onfocus="b()"><g onmouseover="c()"><rect x="0" onclick="d()"/></g></svg>',
    );
    assert.ok(!/\son[a-z]+\s*=/i.test(out), `event handler survived: ${out}`);
  });

  test("the excluded elements are gone, not merely inert", () => {
    const out = formatContent(
      '<svg viewBox="0 0 10 10"><defs></defs><marker></marker><use href="#a"/><foreignObject></foreignObject></svg>',
    );
    for (const tag of ["<defs", "<marker", "<use", "<foreignobject", "<foreignObject"]) {
      assert.ok(!out.includes(tag), `${tag} survived: ${out}`);
    }
  });
});

describe("formatContent — legitimate infographics survive", () => {
  test("a representative inline SVG is preserved", () => {
    const out = formatContent(
      '<svg viewBox="0 0 100 100"><rect width="100" height="100" fill="red"/></svg>',
    );
    assert.ok(out.includes("<svg"), `svg dropped: ${out}`);
    assert.ok(out.includes("<rect"), `rect dropped: ${out}`);
    assert.ok(out.includes('width="100"'), `geometry dropped: ${out}`);
    assert.ok(out.includes('fill="red"'), `fill dropped: ${out}`);
    // sanitize-html lowercases attribute names. That is CORRECT and must not be
    // "fixed": HTML tree construction remaps viewbox -> viewBox for inline SVG
    // (verified with parse5), so responsive scaling still works in the browser.
    assert.ok(/viewbox="0 0 100 100"/i.test(out), `viewBox dropped: ${out}`);
  });

  test("the full shape/text vocabulary the agent draws with is preserved", () => {
    const out = formatContent(
      '<svg viewBox="0 0 200 100" role="img" aria-label="Flujo">' +
        "<title>Flujo</title><desc>Un flujo</desc>" +
        '<g transform="translate(5,5)" stroke="currentColor" stroke-width="2" stroke-dasharray="4 2">' +
        '<path d="M0 0 L10 10"/><circle cx="5" cy="5" r="3"/><ellipse cx="5" cy="5" rx="3" ry="2"/>' +
        '<line x1="0" y1="0" x2="9" y2="9"/><polyline points="0,0 5,5"/><polygon points="0,0 5,5 0,10"/>' +
        '<text x="5" y="9" text-anchor="middle" font-size="14" fill-opacity="0.6">Hola<tspan dx="2">!</tspan></text>' +
        "</g></svg>",
    );
    for (const tag of [
      "<title", "<desc", "<g", "<path", "<circle", "<ellipse",
      "<line", "<polyline", "<polygon", "<text", "<tspan",
    ]) {
      assert.ok(out.includes(tag), `${tag} was stripped: ${out}`);
    }
    assert.ok(out.includes('stroke="currentColor"'), `currentColor dropped: ${out}`);
    assert.ok(out.includes('fill-opacity="0.6"'), `fill-opacity dropped: ${out}`);
    assert.ok(out.includes('transform="translate(5,5)"'), `transform dropped: ${out}`);
  });

  test("the figure/figcaption wrapper survives with its class", () => {
    const out = formatContent(
      '<figure class="article-infographic"><svg viewBox="0 0 10 10"></svg><figcaption>Pie</figcaption></figure>',
    );
    assert.ok(out.includes('class="article-infographic"'), `class dropped: ${out}`);
    assert.ok(out.includes("<figcaption>Pie</figcaption>"), `figcaption dropped: ${out}`);
  });

  test("an infographic embedded in an article leaves the prose untouched", () => {
    const md = [
      "## Antes",
      "",
      "Parrafo previo.",
      "",
      '<figure class="article-infographic">',
      '<svg viewBox="0 0 10 10"><rect x="0" y="0" width="5" height="5" fill="currentColor"/></svg>',
      "<figcaption>Pie</figcaption>",
      "</figure>",
      "",
      "Parrafo posterior.",
      "",
      "## Preguntas frecuentes",
      "",
      "### Cuanto tarda?",
      "",
      "Poco.",
    ].join("\n");
    const out = formatContent(md);
    assert.ok(out.includes("<svg"), `svg dropped: ${out}`);
    assert.ok(out.includes("Parrafo previo."), "prose before the figure was lost");
    assert.ok(out.includes("Parrafo posterior."), "prose after the figure was lost");
    // The FAQ heading shape is a cross-repo contract: buildFaqLd() keys off it
    // to emit FAQPage JSON-LD, so an infographic must never disturb it.
    assert.ok(out.includes("<h2>Preguntas frecuentes</h2>"), `FAQ h2 changed: ${out}`);
    assert.ok(out.includes("<h3>Cuanto tarda?</h3>"), `FAQ h3 changed: ${out}`);
  });
});

describe("formatContent — pre-existing behaviour is unchanged", () => {
  test("ordinary markdown still renders", () => {
    const out = formatContent("## Titulo\n\nTexto con **negrita** y [enlace](/contacto).\n\n- uno\n- dos");
    assert.ok(out.includes("<h2>Titulo</h2>"));
    assert.ok(out.includes("<strong>negrita</strong>"));
    assert.ok(out.includes('<a href="/contacto">enlace</a>'));
    assert.ok(out.includes("<li>uno</li>"));
  });

  test("legacy plain text keeps its line breaks", () => {
    assert.equal(formatContent("Linea uno\nLinea dos"), "<p>Linea uno<br />Linea dos</p>\n");
  });

  test("non-SVG HTML injection is still blocked", () => {
    const out = formatContent('<img src=x onerror="alert(1)"> <iframe src="//evil.tld"></iframe>');
    assert.ok(!out.includes("onerror"), `onerror survived: ${out}`);
    assert.ok(!out.includes("<iframe"), `iframe survived: ${out}`);
    assert.ok(!out.includes("<img"), `img survived: ${out}`);
  });

  test("empty and nullish input stay empty", () => {
    assert.equal(formatContent(""), "");
    assert.equal(formatContent(null), "");
    assert.equal(formatContent(undefined), "");
  });
});
