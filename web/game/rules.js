/**
 * "Pedido a pedido" — the rules of the homepage game, with no DOM in sight.
 *
 * Offices around the warehouse place orders for one of four products. Each
 * order has a patience clock. The player drags the matching product from the
 * dock onto the office: that dispatches a van, and the order is served when the
 * van arrives. An order whose patience runs out costs one of three lives.
 *
 * One simulation runs both faces of the hero:
 *  - `demo`: the idle animation. Orders are dispatched on their own, nothing
 *    is ever lost, and the pace is fixed.
 *  - `play`: the game. The pace comes from `ordersPerMinute` (traffic.js),
 *    the one place difficulty is decided.
 *
 * This module owns every timing (spawn, patience, van travel) so the canvas
 * in hero-game.js only draws what it is told. Tested in src/game/rules.test.js.
 */

import { ordersPerMinute } from "./traffic.js";

export const PRODUCT_TYPES = ["clips", "paper", "pens", "folders"];
export const LIVES = 3;
export const PATIENCE_MS = 15000;
export const VAN_TRAVEL_MS = 1100;
export const DEMO_ORDERS_PER_MINUTE = 24;
// When every office is busy the next order waits this long and tries again,
// instead of being dropped (which would make a full board quieter, not harder).
const RETRY_MS = 400;

/** Deterministic PRNG (mulberry32): same seed, same game. Used by the tests. */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createGame({ mode = "demo", officeCount = 6, rng = Math.random } = {}) {
  const state = {
    mode,
    rng,
    now: 0,
    lives: LIVES,
    served: 0,
    over: false,
    offices: Array.from({ length: officeCount }, (_, id) => ({ id, order: null })),
    // The first order arrives at once, so neither face opens on an empty board.
    nextOrderAt: 0,
  };
  return state;
}

function rate(state) {
  return state.mode === "demo" ? DEMO_ORDERS_PER_MINUTE : ordersPerMinute(state.now);
}

// Gap until the next order: the mean from the current rate, jittered ±40 % so
// arrivals do not tick like a metronome.
function nextGap(state) {
  const mean = 60000 / rate(state);
  return mean * (0.6 + 0.8 * state.rng());
}

function spawn(state, events) {
  const free = state.offices.filter((o) => o.order === null);
  if (free.length === 0) {
    state.nextOrderAt = state.now + RETRY_MS;
    return;
  }
  const office = free[Math.floor(state.rng() * free.length)];
  const type = PRODUCT_TYPES[Math.floor(state.rng() * PRODUCT_TYPES.length)];
  office.order = { type, bornAt: state.now, dispatchedAt: null };
  // Demo mode dispatches each order somewhere between 25 % and 60 % of its
  // patience, so the idle board always shows rings at different stages.
  if (state.mode === "demo") {
    office.order.autoAt = state.now + PATIENCE_MS * (0.25 + 0.35 * state.rng());
  }
  state.nextOrderAt = state.now + nextGap(state);
  events.push({ kind: "ordered", officeId: office.id, type });
}

/**
 * Advance the simulation by `dtMs`. Returns what happened, for the canvas to
 * animate: `ordered`, `dispatched`, `served`, `expired`, `over`.
 */
export function step(state, dtMs) {
  const events = [];
  if (state.over) return events;
  state.now += dtMs;

  for (const office of state.offices) {
    const order = office.order;
    if (!order) continue;
    if (order.dispatchedAt !== null) {
      if (state.now >= order.dispatchedAt + VAN_TRAVEL_MS) {
        office.order = null;
        state.served += 1;
        events.push({ kind: "served", officeId: office.id, type: order.type });
      }
      continue;
    }
    if (state.mode === "demo" && state.now >= order.autoAt) {
      order.dispatchedAt = state.now;
      events.push({ kind: "dispatched", officeId: office.id, type: order.type });
      continue;
    }
    if (state.now >= order.bornAt + PATIENCE_MS) {
      office.order = null;
      if (state.mode === "play") {
        state.lives -= 1;
        events.push({ kind: "expired", officeId: office.id, type: order.type });
        if (state.lives <= 0) {
          state.over = true;
          events.push({ kind: "over", served: state.served });
          return events;
        }
      }
    }
  }

  while (!state.over && state.now >= state.nextOrderAt) spawn(state, events);
  return events;
}

/**
 * The player drops a product of `type` on office `officeId`.
 * Returns "dispatched" (right product, van on its way), "wrong" (that office
 * wants something else) or "none" (no open order there, or game over).
 */
export function deliver(state, officeId, type) {
  if (state.over) return "none";
  const office = state.offices[officeId];
  const order = office && office.order;
  if (!order || order.dispatchedAt !== null) return "none";
  if (order.type !== type) return "wrong";
  order.dispatchedAt = state.now;
  return "dispatched";
}

/** Share of patience left on an order, 1 → 0. A dispatched order stops its clock. */
export function patienceLeft(state, order) {
  const at = order.dispatchedAt ?? state.now;
  return Math.max(0, 1 - (at - order.bornAt) / PATIENCE_MS);
}

/** How far the van for a dispatched order has travelled, 0 → 1. */
export function vanProgress(state, order) {
  if (order.dispatchedAt === null) return 0;
  return Math.min(1, (state.now - order.dispatchedAt) / VAN_TRAVEL_MS);
}
