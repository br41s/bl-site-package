/**
 * The homepage hero's canvas: draws "Pedido a pedido" and turns pointer input
 * into moves. Every rule and every timing lives in rules.js; this file only
 * lays the scene out, paints it, and calls `deliver()` when a product is dropped.
 *
 * Idle, the demo plays itself behind the hero text (one static frame under
 * prefers-reduced-motion). "Jugar" switches the same canvas to the game.
 * Only rendered when the `hero_game` config key is "1" (site/index.njk).
 */

import { createGame, step, deliver, patienceLeft, vanProgress, PRODUCT_TYPES, LIVES } from "./rules.js";

const LABELS = { clips: "Clips", paper: "Papel", pens: "Bolis", folders: "Carpetas" };
// Fixed per product, and each icon also has its own shape, so colour is never
// the only cue. Picked to read on both the light and the dark background.
const PRODUCT_COLORS = { clips: "#3b82f6", paper: "#10b981", pens: "#8b5cf6", folders: "#f59e0b" };
const BEST_KEY = "bl-game-best";
const TRUCK_CYCLE_MS = 14000;

const hero = document.querySelector("[data-hero-game]");
if (hero) init(hero);

function init(hero) {
  const canvas = hero.querySelector(".hero-game-canvas");
  const ctx = canvas.getContext("2d");
  const playBtn = hero.querySelector(".hero-game-play");
  const hud = hero.querySelector(".hero-game-hud");
  const livesEl = hero.querySelector(".hero-game-lives");
  const servedEl = hero.querySelector(".hero-game-served");
  const bestEl = hero.querySelector(".hero-game-best");
  const hint = hero.querySelector(".hero-game-hint");
  const overBox = hero.querySelector(".hero-game-over");
  const overText = hero.querySelector(".hero-game-over-text");
  const company = hero.dataset.company || "Almacén";
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  let state = createGame({ mode: "demo" });
  let L = null; // current layout
  let colors = null;
  let effects = []; // { kind, officeId, at } — scene-only flourishes, real time
  let drag = null; // { type, x, y, sx, sy, moved }
  let selected = null; // tap-to-select alternative to dragging
  let hover = null;
  let raf = 0;
  let last = 0;
  let visible = true;

  playBtn.hidden = false;
  playBtn.addEventListener("click", startGame);
  hero.querySelector(".hero-game-exit").addEventListener("click", exitGame);
  hero.querySelector(".hero-game-again").addEventListener("click", startGame);
  hero.querySelector(".hero-game-leave").addEventListener("click", exitGame);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.mode === "play") exitGame();
  });

  // ── Loop ──────────────────────────────────────────────────────────────
  function animating() {
    return visible && !document.hidden && (state.mode === "play" || !reducedMotion.matches);
  }

  function frame(t) {
    raf = 0;
    // Clamp: after a background tab or a slow frame, jump at most 100 ms so
    // nothing expires unseen.
    const dt = last ? Math.min(100, t - last) : 16;
    last = t;
    handle(step(state, dt));
    draw();
    schedule();
  }

  function schedule() {
    if (!raf && animating()) raf = requestAnimationFrame(frame);
    if (!animating()) last = 0;
  }

  // Reduced motion: a still frame of a board already in progress.
  function stillFrame() {
    if (state.mode === "demo" && reducedMotion.matches) {
      if (state.now === 0) for (let i = 0; i < 120; i++) step(state, 50);
      draw();
    }
  }

  new IntersectionObserver((entries) => {
    visible = entries[0].isIntersecting;
    schedule();
  }).observe(hero);
  document.addEventListener("visibilitychange", schedule);
  reducedMotion.addEventListener("change", () => {
    schedule();
    stillFrame();
  });

  // Theme: tokens are re-read when the toggle flips data-theme or the OS changes.
  new MutationObserver(() => {
    colors = null;
    draw();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    colors = null;
    draw();
  });

  new ResizeObserver(resize).observe(hero);
  resize();
  schedule();

  // ── Game flow ─────────────────────────────────────────────────────────
  function startGame() {
    state = createGame({ mode: "play" });
    effects = [];
    drag = selected = hover = null;
    hero.classList.add("is-playing");
    overBox.hidden = true;
    hud.hidden = false;
    hint.hidden = false;
    setTimeout(() => (hint.hidden = true), 4500);
    updateHud();
    // The hero opens the homepage; scrolling to it with scrollIntoView would
    // tuck its top (and the HUD) under the sticky nav.
    window.scrollTo({ top: 0, behavior: reducedMotion.matches ? "auto" : "smooth" });
    resize();
    schedule();
  }

  function exitGame() {
    state = createGame({ mode: "demo" });
    effects = [];
    drag = selected = hover = null;
    hero.classList.remove("is-playing");
    hud.hidden = overBox.hidden = hint.hidden = true;
    resize();
    stillFrame();
    schedule();
    playBtn.focus();
  }

  function handle(events) {
    const now = performance.now();
    for (const e of events) {
      if (e.kind === "served" || e.kind === "expired") effects.push({ kind: e.kind, officeId: e.officeId, at: now });
      if (e.kind === "over") gameOver(e.served);
    }
    if (state.mode === "play" && events.length) updateHud();
  }

  function readBest() {
    try {
      return Number(localStorage.getItem(BEST_KEY)) || 0;
    } catch {
      return 0;
    }
  }

  function updateHud() {
    livesEl.textContent = "♥".repeat(state.lives) + "♡".repeat(LIVES - state.lives);
    livesEl.setAttribute("aria-label", `${state.lives} vidas`);
    servedEl.textContent = state.served;
    bestEl.textContent = Math.max(readBest(), state.served);
  }

  function gameOver(served) {
    const best = readBest();
    if (served > best) {
      try {
        localStorage.setItem(BEST_KEY, String(served));
      } catch {
        /* private mode: the record just isn't kept */
      }
    }
    overText.textContent =
      served === 1 ? "Fin de la jornada: has servido 1 pedido." : `Fin de la jornada: has servido ${served} pedidos.`;
    if (served > best && best > 0) overText.textContent += " ¡Nuevo récord!";
    overBox.hidden = false;
    hud.hidden = true;
    drag = selected = null;
    hero.querySelector(".hero-game-again").focus();
  }

  // ── Input ─────────────────────────────────────────────────────────────
  function pos(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function inRect(p, r, pad = 0) {
    return p.x >= r.x - pad && p.x <= r.x + r.w + pad && p.y >= r.y - pad && p.y <= r.y + r.h + pad;
  }

  const tileAt = (p) => L.tiles.find((t) => inRect(p, t, 4));
  const officeAt = (p) => L.offices.find((o) => inRect(p, o.hit));

  function drop(office, type) {
    const result = deliver(state, office.id, type);
    if (result === "wrong") effects.push({ kind: "wrong", officeId: office.id, at: performance.now() });
    if (result === "dispatched") selected = null;
  }

  canvas.addEventListener("pointerdown", (e) => {
    if (state.mode !== "play" || state.over) return;
    const p = pos(e);
    const tile = tileAt(p);
    if (tile) {
      drag = { type: tile.type, x: p.x, y: p.y, sx: p.x, sy: p.y, moved: false };
      canvas.setPointerCapture(e.pointerId);
      return;
    }
    const office = officeAt(p);
    if (office && selected) drop(office, selected);
  });

  canvas.addEventListener("pointermove", (e) => {
    if (state.mode !== "play") return;
    const p = pos(e);
    hover = officeAt(p) || null;
    if (!drag) return;
    drag.x = p.x;
    drag.y = p.y;
    if (Math.hypot(p.x - drag.sx, p.y - drag.sy) > 8) drag.moved = true;
  });

  function endDrag(e) {
    if (!drag) return;
    const p = pos(e);
    const office = officeAt(p);
    if (drag.moved && office) drop(office, drag.type);
    else if (!drag.moved) selected = selected === drag.type ? null : drag.type;
    drag = null;
  }
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", () => (drag = null));

  // ── Layout ────────────────────────────────────────────────────────────
  function resize() {
    const w = hero.clientWidth;
    const h = hero.clientHeight;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    L = layout(w, h, state.offices.length);
    if (state.mode === "demo" && reducedMotion.matches) stillFrame();
    else draw();
  }

  function grid(area, cols, rows, count) {
    const cw = area.w / cols;
    const ch = area.h / rows;
    const cells = [];
    for (let i = 0; i < count; i++) {
      const cx = area.x + (i % cols) * cw;
      const cy = area.y + Math.floor(i / cols) * ch;
      cells.push({ x: cx, y: cy, w: cw, h: ch });
    }
    return cells;
  }

  function layout(w, h, count) {
    const wide = w >= 720 && w > h * 1.1;
    let officeArea, warehouse, tileArea, tileCols, truckFrom, truckTo;
    if (wide && state.mode === "demo") {
      // Idle on a wide screen the hero text owns the left half, so the whole
      // scene moves right, and the dock (a control, useless while idle) goes.
      officeArea = { x: w * 0.53, y: h * 0.1, w: w * 0.45, h: h * 0.56 };
      warehouse = { x: w * 0.63, y: h * 0.72, w: w * 0.24, h: h * 0.18 };
      tileArea = null;
      truckFrom = { x: w + 60, y: warehouse.y + warehouse.h * 0.5 };
      truckTo = { x: warehouse.x + warehouse.w + 44, y: warehouse.y + warehouse.h * 0.5 };
    } else if (wide) {
      const colX = w * 0.72;
      const colW = w * 0.24;
      officeArea = { x: w * 0.05, y: h * 0.12, w: w * 0.62, h: h * 0.8 };
      warehouse = { x: colX + colW * 0.08, y: h * 0.26, w: colW * 0.84, h: h * 0.24 };
      tileArea = { x: colX, y: h * 0.58, w: colW, h: h * 0.34 };
      tileCols = 2;
      truckFrom = { x: warehouse.x + warehouse.w * 0.5, y: -60 };
      truckTo = { x: warehouse.x + warehouse.w * 0.5, y: warehouse.y - 34 };
    } else {
      officeArea = { x: w * 0.04, y: h * 0.06, w: w * 0.92, h: h * 0.6 };
      warehouse = { x: w * 0.06, y: h * 0.69, w: w * 0.4, h: h * 0.12 };
      tileArea = { x: w * 0.03, y: h * 0.84, w: w * 0.94, h: h * 0.14 };
      tileCols = 4;
      truckFrom = { x: w + 60, y: warehouse.y + warehouse.h * 0.5 };
      truckTo = { x: warehouse.x + warehouse.w + 44, y: warehouse.y + warehouse.h * 0.5 };
    }
    // Streets leave from the side facing the offices: the left wall when the
    // warehouse stands in its own column, otherwise the roof edge (offices above).
    const door =
      wide && tileArea
        ? { x: warehouse.x, y: warehouse.y + warehouse.h * 0.7 }
        : { x: warehouse.x + warehouse.w * 0.5, y: warehouse.y };

    const cols = wide ? 3 : 2;
    const offices = grid(officeArea, cols, Math.ceil(count / cols), count).map((cell, id) => {
      const bw = Math.min(cell.w * 0.5, cell.h * 0.55);
      const bh = bw * 0.78;
      const b = { x: cell.x + (cell.w - bw) / 2, y: cell.y + cell.h - bh - cell.h * 0.08, w: bw, h: bh };
      const r = Math.max(14, Math.min(34, Math.min(cell.w, cell.h) * 0.17));
      const bubble = { x: b.x + bw / 2, y: b.y - r - 8, r };
      const hit = { x: cell.x + 4, y: bubble.y - r - 4, w: cell.w - 8, h: b.y + bh - (bubble.y - r - 4) };
      return { id, b, bubble, hit, door: { x: b.x + bw / 2, y: b.y + bh } };
    });

    let tiles = [];
    if (tileArea) {
      const cells = grid(tileArea, tileCols, Math.ceil(PRODUCT_TYPES.length / tileCols), PRODUCT_TYPES.length);
      const s = Math.min(...cells.map((c) => Math.min(c.w, c.h))) * 0.86;
      tiles = cells.map((c, i) => ({
        type: PRODUCT_TYPES[i],
        x: c.x + (c.w - s) / 2,
        y: c.y + (c.h - s) / 2,
        w: s,
        h: s,
      }));
    }
    return { w, h, wide, offices, warehouse, door, tiles, truckFrom, truckTo };
  }

  // ── Drawing ───────────────────────────────────────────────────────────
  function readColors() {
    const css = getComputedStyle(document.documentElement);
    const v = (name) => css.getPropertyValue(name).trim();
    return {
      bg: v("--bg"),
      subtle: v("--bg-subtle"),
      border: v("--border"),
      text: v("--text-primary"),
      muted: v("--text-muted"),
      accent: v("--accent"),
      font: getComputedStyle(document.body).fontFamily,
    };
  }

  function rr(x, y, w, h, r) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
  }

  function draw() {
    if (!L) return;
    colors = colors || readColors();
    const c = colors;
    ctx.clearRect(0, 0, L.w, L.h);

    // Streets from the warehouse door to every office.
    ctx.lineCap = "round";
    for (const o of L.offices) {
      ctx.strokeStyle = c.subtle;
      ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.moveTo(L.door.x, L.door.y);
      ctx.lineTo(o.door.x, o.door.y);
      ctx.stroke();
    }

    drawTruck(c);
    drawWarehouse(c);
    for (const o of L.offices) drawOffice(c, o);
    for (const o of L.offices) drawVan(c, o);
    drawEffects(c);
    drawTiles(c);
    if (drag && drag.moved) drawIcon(drag.type, drag.x, drag.y, 22, 1);
  }

  function drawWarehouse(c) {
    const w = L.warehouse;
    ctx.fillStyle = c.subtle;
    ctx.strokeStyle = c.border;
    ctx.lineWidth = 2;
    rr(w.x, w.y, w.w, w.h, 6);
    ctx.fill();
    ctx.stroke();
    // Roof band in the brand accent, with the company's name on it.
    ctx.fillStyle = c.accent;
    rr(w.x, w.y, w.w, Math.max(18, w.h * 0.28), 6);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.font = `600 ${Math.max(10, Math.min(14, w.h * 0.14))}px ${c.font}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(fit(company, w.w - 12), w.x + w.w / 2, w.y + Math.max(18, w.h * 0.28) / 2);
    // Loading bays.
    ctx.fillStyle = c.border;
    const bays = 3;
    const bw = w.w / (bays * 2 + 1);
    for (let i = 0; i < bays; i++) {
      ctx.fillRect(w.x + bw * (1 + i * 2), w.y + w.h * 0.55, bw, w.h * 0.45);
    }
  }

  function fit(text, max) {
    if (ctx.measureText(text).width <= max) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(t + "…").width > max) t = t.slice(0, -1);
    return t + "…";
  }

  function drawOffice(c, o) {
    const { b, bubble } = o;
    const highlighted = hover === o && (drag || selected) && state.mode === "play";
    ctx.fillStyle = c.subtle;
    ctx.strokeStyle = highlighted ? c.accent : c.border;
    ctx.lineWidth = highlighted ? 3 : 2;
    rr(b.x, b.y, b.w, b.h, 4);
    ctx.fill();
    ctx.stroke();
    // Windows: 3×2, the door in the middle of the bottom row.
    ctx.fillStyle = c.border;
    const ww = b.w / 7;
    const wh = b.h / 6;
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 3; col++) {
        if (row === 1 && col === 1) continue;
        ctx.fillRect(b.x + ww * (1 + col * 2), b.y + wh * (1 + row * 2.2), ww, wh);
      }
    }
    ctx.fillRect(b.x + ww * 3, b.y + b.h - wh * 1.8, ww, wh * 1.8);

    const order = state.offices[o.id].order;
    if (!order || order.dispatchedAt !== null) return;
    const left = patienceLeft(state, order);
    // Bubble, icon, and the patience ring running down around it.
    ctx.fillStyle = c.bg;
    ctx.strokeStyle = c.border;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(bubble.x, bubble.y, bubble.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = left > 0.5 ? "#16a34a" : left > 0.25 ? "#f59e0b" : "#dc2626";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(bubble.x, bubble.y, bubble.r + 1, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * left);
    ctx.stroke();
    drawIcon(order.type, bubble.x, bubble.y, bubble.r * 0.62, 1);
  }

  function drawVan(c, o) {
    const order = state.offices[o.id].order;
    if (!order || order.dispatchedAt === null) return;
    const t = vanProgress(state, order);
    const x = L.door.x + (o.door.x - L.door.x) * t;
    const y = L.door.y + (o.door.y - L.door.y) * t;
    vehicle(x, y, Math.atan2(o.door.y - L.door.y, o.door.x - L.door.x), 26, 14, PRODUCT_COLORS[order.type], c);
  }

  function drawTruck(c) {
    // Decorative supplier run: drive in, unload, drive back out, wait.
    const t = state.now % TRUCK_CYCLE_MS;
    let k;
    if (t < 2500) k = t / 2500;
    else if (t < 5500) k = 1;
    else if (t < 8000) k = 1 - (t - 5500) / 2500;
    else return;
    k = k * k * (3 - 2 * k); // ease in-out
    const { truckFrom: a, truckTo: b } = L;
    const x = a.x + (b.x - a.x) * k;
    const y = a.y + (b.y - a.y) * k;
    vehicle(x, y, Math.atan2(b.y - a.y, b.x - a.x), 56, 24, c.muted, c, "Proveedor");
  }

  function vehicle(x, y, angle, len, wid, body, c, label) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.fillStyle = body;
    rr(-len / 2, -wid / 2, len * 0.72, wid, 3);
    ctx.fill();
    ctx.fillStyle = c.text;
    rr(len * 0.24, -wid / 2 + 2, len * 0.26, wid - 4, 3);
    ctx.fill();
    if (label && Math.abs(Math.sin(angle)) < 0.5) {
      // Driving leftwards the whole truck is rotated half a turn; turn the
      // lettering back so it never reads upside down.
      ctx.translate(-len * 0.14, 0);
      if (Math.cos(angle) < 0) ctx.rotate(Math.PI);
      ctx.fillStyle = "#fff";
      ctx.font = `600 9px ${c.font}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, 0, 0);
    }
    ctx.restore();
  }

  function drawEffects(c) {
    const now = performance.now();
    effects = effects.filter((e) => now - e.at < 900);
    for (const e of effects) {
      const o = L.offices[e.officeId];
      const k = (now - e.at) / 900;
      ctx.globalAlpha = 1 - k;
      ctx.font = `700 18px ${c.font}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      if (e.kind === "served") {
        ctx.fillStyle = "#16a34a";
        ctx.fillText("+1", o.bubble.x, o.bubble.y - 20 * k);
      } else if (e.kind === "expired") {
        ctx.fillStyle = "#dc2626";
        ctx.fillText("✕", o.bubble.x, o.bubble.y);
      } else if (e.kind === "wrong") {
        ctx.strokeStyle = "#dc2626";
        ctx.lineWidth = 3;
        const dx = Math.sin(k * Math.PI * 6) * 5;
        rr(o.b.x - 4 + dx, o.b.y - 4, o.b.w + 8, o.b.h + 8, 6);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  }

  function drawTiles(c) {
    const play = state.mode === "play";
    for (const t of L.tiles) {
      const active = selected === t.type || (drag && drag.type === t.type);
      ctx.globalAlpha = play ? 1 : 0.75;
      ctx.fillStyle = c.bg;
      ctx.strokeStyle = active ? c.accent : c.border;
      ctx.lineWidth = active ? 3 : 2;
      rr(t.x, t.y, t.w, t.h, 10);
      ctx.fill();
      ctx.stroke();
      drawIcon(t.type, t.x + t.w / 2, t.y + t.h * 0.42, t.w * 0.24, 1);
      ctx.fillStyle = c.muted;
      ctx.font = `500 ${Math.max(10, Math.min(13, t.w * 0.16))}px ${c.font}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(LABELS[t.type], t.x + t.w / 2, t.y + t.h * 0.82);
      ctx.globalAlpha = 1;
    }
  }

  // One small drawing per product, sized by `s` (half-extent), centred on x,y.
  function drawIcon(type, x, y, s, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    const col = PRODUCT_COLORS[type];
    ctx.strokeStyle = col;
    ctx.fillStyle = col;
    ctx.lineWidth = Math.max(2, s * 0.16);
    ctx.lineJoin = ctx.lineCap = "round";
    if (type === "clips") {
      // Paper clip: three nested U turns.
      ctx.beginPath();
      ctx.moveTo(-s * 0.3, s * 0.3);
      ctx.lineTo(-s * 0.3, -s * 0.6);
      ctx.arc(0, -s * 0.6, s * 0.3, Math.PI, 0);
      ctx.lineTo(s * 0.3, s * 0.6);
      ctx.arc(0, s * 0.6, s * 0.45, 0, Math.PI);
      ctx.lineTo(-s * 0.45, -s * 0.85);
      ctx.stroke();
    } else if (type === "paper") {
      // A ream: two offset sheets with ruled lines.
      ctx.globalAlpha = alpha * 0.45;
      ctx.fillRect(-s * 0.5, -s * 0.85, s * 1.2, s * 1.6);
      ctx.globalAlpha = alpha;
      ctx.fillRect(-s * 0.7, -s * 0.7, s * 1.2, s * 1.6);
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = Math.max(1, s * 0.08);
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.moveTo(-s * 0.5, -s * 0.35 + i * s * 0.4);
        ctx.lineTo(s * 0.3, -s * 0.35 + i * s * 0.4);
        ctx.stroke();
      }
    } else if (type === "pens") {
      // A pen at 45°: barrel, nib, cap clip.
      ctx.rotate(-Math.PI / 4);
      ctx.fillRect(-s * 0.9, -s * 0.18, s * 1.4, s * 0.36);
      ctx.beginPath();
      ctx.moveTo(s * 0.5, -s * 0.18);
      ctx.lineTo(s * 0.95, 0);
      ctx.lineTo(s * 0.5, s * 0.18);
      ctx.fill();
      ctx.fillRect(-s * 0.75, -s * 0.34, s * 0.6, s * 0.12);
    } else {
      // Folder: tab and body.
      ctx.beginPath();
      ctx.moveTo(-s * 0.9, -s * 0.55);
      ctx.lineTo(-s * 0.3, -s * 0.55);
      ctx.lineTo(-s * 0.15, -s * 0.38);
      ctx.lineTo(s * 0.9, -s * 0.38);
      ctx.lineTo(s * 0.9, s * 0.7);
      ctx.lineTo(-s * 0.9, s * 0.7);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }
}
