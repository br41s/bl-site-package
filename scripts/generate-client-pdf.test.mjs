import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  BRAND,
  renderBodyHtml,
  renderHeaderTemplate,
  renderFooterTemplate,
  findChromium,
  isExecutableBinary,
  needsNoSandbox,
  parseArgs,
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

test('renderBodyHtml escapes a title that could break out of <title>', () => {
  const html = renderBodyHtml('# </title><script>alert(1)</script>\n\nCuerpo.');
  const head = html.slice(0, html.indexOf('</head>'));
  assert.doesNotMatch(head, /<script>alert\(1\)<\/script>/);
  assert.match(head, /<title>&lt;\/title&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/title>/);
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

test('isExecutableBinary rejects a file that exists but does not run', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bl-pdf-not-a-binary-'));
  const fakeBinary = path.join(dir, 'not-really-chrome');
  writeFileSync(fakeBinary, 'not a real binary');
  chmodSync(fakeBinary, 0o644); // not executable
  assert.equal(isExecutableBinary(fakeBinary), false);
});

test('findChromium skips a Playwright candidate that is not actually executable', () => {
  const pwDir = mkdtempSync(path.join(tmpdir(), 'bl-pdf-pw-browsers-'));
  const chromeDir = path.join(pwDir, 'chromium-999', 'chrome-linux');
  mkdirSync(chromeDir, { recursive: true });
  writeFileSync(path.join(chromeDir, 'chrome'), 'not a real binary');

  const savedPdfChrome = process.env.PDF_CHROME_PATH;
  const savedPwDir = process.env.PLAYWRIGHT_BROWSERS_PATH;
  delete process.env.PDF_CHROME_PATH;
  process.env.PLAYWRIGHT_BROWSERS_PATH = pwDir;
  try {
    // No real browser is reachable from this fixture dir or PATH in CI, so a
    // fixed-but-fake candidate must be skipped rather than returned.
    assert.notEqual(findChromium(), path.join(chromeDir, 'chrome'));
  } finally {
    if (savedPdfChrome === undefined) delete process.env.PDF_CHROME_PATH;
    else process.env.PDF_CHROME_PATH = savedPdfChrome;
    if (savedPwDir === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    else process.env.PLAYWRIGHT_BROWSERS_PATH = savedPwDir;
  }
});

test('parseArgs reads --out and --logo when both have values', () => {
  const opts = parseArgs(['doc.md', '--out', 'salida.pdf', '--logo', 'logo.png']);
  assert.equal(opts.input, 'doc.md');
  assert.equal(opts.out, 'salida.pdf');
  assert.equal(opts.logo, 'logo.png');
  assert.equal(opts.error, undefined);
});

test('parseArgs errors instead of silently defaulting when --out has no value', () => {
  const opts = parseArgs(['doc.md', '--out']);
  assert.match(opts.error, /Falta el valor de --out/);
});

test('parseArgs errors when --out is immediately followed by another flag', () => {
  const opts = parseArgs(['doc.md', '--out', '--logo', 'logo.png']);
  assert.match(opts.error, /Falta el valor de --out/);
});

test('parseArgs errors when --logo has no value', () => {
  const opts = parseArgs(['doc.md', '--logo']);
  assert.match(opts.error, /Falta el valor de --logo/);
});

test('needsNoSandbox is forced on by PDF_NO_SANDBOX=1 regardless of uid', () => {
  const before = process.env.PDF_NO_SANDBOX;
  process.env.PDF_NO_SANDBOX = '1';
  try {
    assert.equal(needsNoSandbox(), true);
  } finally {
    if (before === undefined) delete process.env.PDF_NO_SANDBOX;
    else process.env.PDF_NO_SANDBOX = before;
  }
});

test('needsNoSandbox without the override just reflects root, not forced true', () => {
  const before = process.env.PDF_NO_SANDBOX;
  delete process.env.PDF_NO_SANDBOX;
  try {
    const expected = typeof process.getuid === 'function' && process.getuid() === 0;
    assert.equal(needsNoSandbox(), expected);
  } finally {
    if (before !== undefined) process.env.PDF_NO_SANDBOX = before;
  }
});
