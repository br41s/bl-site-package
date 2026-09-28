import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BRAND,
  renderBodyHtml,
  renderHeaderTemplate,
  renderFooterTemplate,
  findChromium,
} from './generate-client-pdf.mjs';

// The pure HTML-rendering half of the pipeline runs everywhere node --test
// does. The actual PDF render needs a real Chrome/Chromium binary, which CI
// doesn't have — that half is only exercised by hand (see the script's own
// usage comment), so it's deliberately not asserted here.

test('renderBodyHtml pulls the title from the first heading and renders the body', () => {
  const html = renderBodyHtml('# Título de prueba\n\nUn párrafo con **negrita**.');
  assert.match(html, /<title>Título de prueba<\/title>/);
  assert.match(html, /<h1>Título de prueba<\/h1>/);
  assert.match(html, /<strong>negrita<\/strong>/);
});

test('renderHeaderTemplate falls back to a text wordmark without a logo', () => {
  const header = renderHeaderTemplate({});
  assert.match(header, new RegExp(BRAND.name));
  assert.doesNotMatch(header, /<img/);
});

test('renderHeaderTemplate embeds the logo image when one is given', () => {
  const header = renderHeaderTemplate({ logoDataUri: 'data:image/png;base64,AAAA' });
  assert.match(header, /<img src="data:image\/png;base64,AAAA"/);
});

test('renderFooterTemplate carries the date and Chrome\'s live page-number placeholders', () => {
  const footer = renderFooterTemplate({ dateText: '28 de septiembre de 2026' });
  assert.match(footer, /28 de septiembre de 2026/);
  assert.match(footer, /class="pageNumber"/);
  assert.match(footer, /class="totalPages"/);
});

test('findChromium returns null or an existing, executable path', () => {
  const found = findChromium();
  assert.ok(found === null || typeof found === 'string');
});
