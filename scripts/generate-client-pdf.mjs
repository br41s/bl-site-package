#!/usr/bin/env node
// Turns a client-facing markdown doc (INSTRUCCIONES-CLIENTE.md today, any
// future one tomorrow) into a branded PDF.
//
// This runs on whoever's machine is prepping a client delivery, never inside
// the deployed app or the build: it needs a Chrome/Chromium binary and, for
// the brand webfonts, an internet connection, neither of which the Docker
// image or a client's server has.
//
// Uso:
//   node scripts/generate-client-pdf.mjs INSTRUCCIONES-CLIENTE.md
//   node scripts/generate-client-pdf.mjs INSTRUCCIONES-CLIENTE.md --out /ruta/salida.pdf
//   node scripts/generate-client-pdf.mjs INSTRUCCIONES-CLIENTE.md --logo ruta/logo.png
//
// Busca un navegador en, por orden: PDF_CHROME_PATH, el Chromium de
// Playwright (PLAYWRIGHT_BROWSERS_PATH — el que ya trae este entorno) y los
// binarios habituales de Chrome/Chromium del sistema.
//
// El encabezado/pie repetidos en cada página vienen de la propia plantilla
// de impresión de Chrome (`Page.printToPDF` vía DevTools Protocol), no de un
// truco de CSS: es el único mecanismo de Chromium que de verdad repite un
// header/footer por página con numeración real, así que hablamos con Chrome
// por su protocolo en lugar de por el flag `--print-to-pdf` de la CLI.

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { marked } from 'marked';

// Mirrors the package's own default theme (web/style.css --accent, --font,
// --font-display) — the closest thing BigLobster has to a documented brand
// palette today. There is no logo file in this repo yet, so the header
// renders a text wordmark unless --logo points to a real one. Update this
// object (and re-run for any doc that needs it) once a real brand kit shows
// up, rather than hand-editing generated PDFs.
export const BRAND = {
  name: 'BigLobster',
  accent: '#b8391c',
  accentDark: '#8c2b14',
  ink: '#111318',
  textSecondary: '#2d3240',
  muted: '#5b6375',
  border: '#dde1e9',
  bgSubtle: '#f7f8fa',
  font: '"Inter", -apple-system, "Segoe UI", Arial, sans-serif',
  fontDisplay: '"DM Serif Display", Georgia, serif',
};

// Margins reserved on every page for the header/footer bands, in mm — also
// what Page.printToPDF is told to leave blank (converted to inches there).
const MARGIN_MM = { top: 22, bottom: 14, left: 18, right: 18 };
const MM_PER_IN = 25.4;

function docTitleOf(markdownSource, title) {
  return title || (markdownSource.match(/^#\s+(.+)$/m)?.[1] ?? 'Documento');
}

// The title comes from the doc's own first heading (or --title), interpolated
// straight into <title> — a heading containing `</title><script>` or similar
// would otherwise break out of the head and inject into the page Chrome
// prints. Chrome's own header/footer .title placeholder is safe on its own
// (it reads document.title as text), but this raw spot in the HTML is not.
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderBodyHtml(markdownSource, { title } = {}) {
  const body = marked.parse(markdownSource);
  const docTitle = docTitleOf(markdownSource, title);

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>${escapeHtml(docTitle)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=DM+Serif+Display&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; }
  html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    font-family: ${BRAND.font};
    color: ${BRAND.ink};
    font-size: 12px;
    line-height: 1.55;
    margin: 0;
  }
  h1 { font-family: ${BRAND.fontDisplay}; font-size: 24px; color: ${BRAND.accentDark}; margin: 0 0 4px; }
  h1 + p { color: ${BRAND.muted}; font-size: 12px; margin: 0 0 26px; }
  h2 {
    font-family: ${BRAND.fontDisplay};
    font-size: 16px;
    color: ${BRAND.accentDark};
    margin-top: 30px;
    border-bottom: 1px solid ${BRAND.border};
    padding-bottom: 5px;
  }
  h3 { font-size: 13.5px; color: ${BRAND.textSecondary}; margin-top: 18px; }
  code { background: ${BRAND.bgSubtle}; padding: 1px 5px; border-radius: 3px; font-size: 11px; }
  pre { background: ${BRAND.bgSubtle}; padding: 10px; border-radius: 6px; white-space: pre-wrap; overflow-wrap: break-word; }
  blockquote {
    border-left: 3px solid ${BRAND.accent};
    margin: 0;
    padding: 6px 14px;
    background: ${BRAND.bgSubtle};
    color: ${BRAND.textSecondary};
  }
  a { color: ${BRAND.accentDark}; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; }
  th, td { border: 1px solid ${BRAND.border}; padding: 5px 9px; text-align: left; font-size: 11px; }
  th { background: ${BRAND.bgSubtle}; }
  ul, ol { padding-left: 20px; }
  hr { border: none; border-top: 1px solid ${BRAND.border}; margin: 28px 0; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

// Chrome's header/footer templates run in their own sandboxed frame — no
// external stylesheets or webfonts, only inline styles and system fonts.
// That's fine: it's a thin band, not body copy.
export function renderHeaderTemplate({ logoDataUri } = {}) {
  const mark = logoDataUri
    ? `<img src="${logoDataUri}" style="height:9px; display:block;">`
    : `<span style="font-weight:700;">${BRAND.name}</span>`;
  return `
<div style="width:100%; font-size:8px; font-family:Arial,Helvetica,sans-serif; color:#fff; background:${BRAND.accent}; -webkit-print-color-adjust:exact; padding:5px 18px; display:flex; align-items:center; justify-content:space-between; box-sizing:border-box;">
  <span>${mark}</span>
  <span style="text-transform:uppercase; letter-spacing:0.06em; opacity:0.92;" class="title"></span>
</div>`;
}

export function renderFooterTemplate({ dateText } = {}) {
  return `
<div style="width:100%; font-size:8px; font-family:Arial,Helvetica,sans-serif; color:${BRAND.muted}; border-top:1px solid ${BRAND.border}; padding:4px 18px; display:flex; align-items:center; justify-content:space-between; box-sizing:border-box;">
  <span>${BRAND.name} · <span class="title"></span></span>
  <span>${dateText} · Página <span class="pageNumber"></span> de <span class="totalPages"></span></span>
</div>`;
}

export function findChromium() {
  const envPath = process.env.PDF_CHROME_PATH;
  if (envPath && existsSync(envPath)) return envPath;

  const pwDir = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (pwDir && existsSync(pwDir)) {
    for (const entry of readdirSync(pwDir)) {
      if (!entry.startsWith('chromium-')) continue;
      const candidate = path.join(pwDir, entry, 'chrome-linux', 'chrome');
      if (existsSync(candidate)) return candidate;
    }
  }

  const common = [
    'google-chrome-stable',
    'google-chrome',
    'chromium-browser',
    'chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const bin of common) {
    try {
      execFileSync(bin, ['--version'], { stdio: 'ignore' });
      return bin;
    } catch {
      // Not on PATH (or not this platform) — try the next candidate.
    }
  }
  return null;
}

// Chrome refuses to start as root without --no-sandbox (the common case in a
// container/CI runner), but the flag drops OS-level sandbox protection —
// unwanted on the ordinary desktop machine this script is meant to run on
// (see the file header: whoever is prepping a client delivery). Root is
// detected automatically; PDF_NO_SANDBOX=1 forces it for any other
// containerised environment where root detection doesn't apply.
export function needsNoSandbox() {
  return process.env.PDF_NO_SANDBOX === '1' || (typeof process.getuid === 'function' && process.getuid() === 0);
}

function launchChrome(chromePath, userDataDir) {
  const proc = spawn(
    chromePath,
    [
      '--headless=new',
      '--disable-gpu',
      ...(needsNoSandbox() ? ['--no-sandbox'] : []),
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );

  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString();
      const m = buf.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//);
      if (m) {
        proc.stderr.off('data', onData);
        resolve({ proc, port: Number(m[1]) });
      }
    };
    proc.stderr.on('data', onData);
    proc.once('error', reject);
    proc.once('exit', (code) => reject(new Error(`Chrome salió (código ${code}) antes de abrir el puerto de depuración`)));
    setTimeout(() => reject(new Error('Timeout esperando a que Chrome abra el puerto de depuración')), 15000);
  });
}

function cdpClient(ws) {
  let nextId = 0;
  const pending = new Map();
  const listeners = new Set();

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
    if (msg.method) {
      for (const fn of listeners) fn(msg.method, msg.params);
    }
  });

  return {
    send(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    waitFor(method) {
      return new Promise((resolve) => {
        const fn = (m, params) => {
          if (m === method) {
            listeners.delete(fn);
            resolve(params);
          }
        };
        listeners.add(fn);
      });
    },
  };
}

async function printToPdf(chrome, htmlPath, { headerTemplate, footerTemplate }) {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'bl-pdf-profile-'));
  const { proc, port } = await launchChrome(chrome, userDataDir);
  try {
    const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then(
      (r) => r.json(),
    );
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });

    const cdp = cdpClient(ws);
    await cdp.send('Page.enable');
    const loaded = cdp.waitFor('Page.loadEventFired');
    await cdp.send('Page.navigate', { url: `file://${htmlPath}` });
    await loaded;
    // Fonts load over the network after the load event; give them a moment,
    // and don't let a slow/offline connection hang the whole run.
    await cdp.send('Runtime.evaluate', {
      expression: 'document.fonts.ready.then(() => true)',
      awaitPromise: true,
      timeout: 5000,
    }).catch(() => {});

    const { data } = await cdp.send('Page.printToPDF', {
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate,
      footerTemplate,
      marginTop: MARGIN_MM.top / MM_PER_IN,
      marginBottom: MARGIN_MM.bottom / MM_PER_IN,
      marginLeft: MARGIN_MM.left / MM_PER_IN,
      marginRight: MARGIN_MM.right / MM_PER_IN,
    });
    ws.close();
    return Buffer.from(data, 'base64');
  } finally {
    // Chrome keeps files in userDataDir open for a moment after SIGTERM —
    // wait for it to actually exit before cleaning up, with retries as a
    // safety net against that race rather than leaking the profile dir.
    await new Promise((resolve) => {
      proc.once('exit', resolve);
      proc.kill();
      setTimeout(resolve, 3000);
    });
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
}

function parseArgs(argv) {
  const [input, ...rest] = argv;
  const opts = { input, out: null, logo: null };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--out') opts.out = rest[++i];
    else if (rest[i] === '--logo') opts.logo = rest[++i];
  }
  return opts;
}

async function main() {
  const { input, out, logo } = parseArgs(process.argv.slice(2));
  if (!input) {
    console.error(
      'Uso: node scripts/generate-client-pdf.mjs <doc.md> [--out salida.pdf] [--logo logo.png]',
    );
    process.exitCode = 1;
    return;
  }

  const mdPath = path.resolve(input);
  if (!existsSync(mdPath)) {
    console.error(`No existe: ${mdPath}`);
    process.exitCode = 1;
    return;
  }

  const chrome = findChromium();
  if (!chrome) {
    console.error(
      'No se encontró Chrome/Chromium. Instala Google Chrome, o define PDF_CHROME_PATH ' +
        'apuntando a un binario (p. ej. el que instala `npx playwright install chromium`).',
    );
    process.exitCode = 1;
    return;
  }

  let logoDataUri;
  if (logo) {
    const logoPath = path.resolve(logo);
    const ext = path.extname(logoPath).slice(1) || 'png';
    logoDataUri = `data:image/${ext};base64,${readFileSync(logoPath).toString('base64')}`;
  }

  const outPath = out ? path.resolve(out) : mdPath.replace(/\.md$/i, '.pdf');
  const markdown = readFileSync(mdPath, 'utf8');
  const html = renderBodyHtml(markdown);
  const dateText = new Date().toLocaleDateString('es-ES', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const tmpDir = mkdtempSync(path.join(tmpdir(), 'bl-pdf-'));
  const htmlPath = path.join(tmpDir, 'doc.html');
  writeFileSync(htmlPath, html);

  const pdf = await printToPdf(chrome, htmlPath, {
    headerTemplate: renderHeaderTemplate({ logoDataUri }),
    footerTemplate: renderFooterTemplate({ dateText }),
  });
  writeFileSync(outPath, pdf);
  rmSync(tmpDir, { recursive: true, force: true });

  console.log(`PDF generado: ${outPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
