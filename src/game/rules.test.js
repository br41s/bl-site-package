// Rules of the homepage game (web/game/rules.js). Kept in src/ so the test is
// never copied into the built site.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createGame,
  step,
  deliver,
  patienceLeft,
  seededRandom,
  LIVES,
  PATIENCE_MS,
  VAN_TRAVEL_MS,
} from "../../web/game/rules.js";

function run(state, ms, dt = 50) {
  const events = [];
  for (let t = 0; t < ms; t += dt) events.push(...step(state, dt));
  return events;
}

const openOrder = (state) => state.offices.find((o) => o.order && o.order.dispatchedAt === null);

test("the first order arrives straight away", () => {
  const state = createGame({ mode: "play", rng: seededRandom(1) });
  const events = step(state, 16);
  assert.equal(events.filter((e) => e.kind === "ordered").length, 1);
});

test("the right product dispatches a van and the order is served on arrival", () => {
  const state = createGame({ mode: "play", rng: seededRandom(2) });
  step(state, 16);
  const office = openOrder(state);
  assert.equal(deliver(state, office.id, office.order.type), "dispatched");
  // Still on the road: not served yet, and the patience clock has stopped.
  run(state, VAN_TRAVEL_MS - 100);
  assert.equal(state.served, 0);
  assert.ok(patienceLeft(state, office.order) > 0.9);
  const events = run(state, 200);
  assert.ok(events.some((e) => e.kind === "served" && e.officeId === office.id));
  assert.equal(state.served, 1);
});

test("the wrong product is refused and changes nothing", () => {
  const state = createGame({ mode: "play", rng: seededRandom(3) });
  step(state, 16);
  const office = openOrder(state);
  const wrong = ["clips", "paper", "pens", "folders"].find((t) => t !== office.order.type);
  assert.equal(deliver(state, office.id, wrong), "wrong");
  assert.equal(office.order.dispatchedAt, null);
});

test("dropping on an office with no open order does nothing", () => {
  const state = createGame({ mode: "play", rng: seededRandom(4) });
  step(state, 16);
  const idle = state.offices.find((o) => o.order === null);
  assert.equal(deliver(state, idle.id, "paper"), "none");
});

test("an order left to expire costs a life, and the third ends the game", () => {
  const state = createGame({ mode: "play", rng: seededRandom(5) });
  const events = run(state, PATIENCE_MS * 4);
  assert.equal(state.lives, 0);
  assert.equal(state.over, true);
  assert.equal(events.filter((e) => e.kind === "expired").length, LIVES);
  assert.equal(events.at(-1).kind, "over");
  // Once over, time stops and drops are ignored.
  assert.deepEqual(step(state, 1000), []);
  assert.equal(deliver(state, 0, "paper"), "none");
});

test("the demo serves orders on its own and never loses a life", () => {
  const state = createGame({ mode: "demo", rng: seededRandom(6) });
  const events = run(state, 5 * 60000, 100);
  assert.equal(state.lives, LIVES);
  assert.equal(state.over, false);
  assert.ok(state.served > 50, `only ${state.served} served`);
  assert.equal(events.filter((e) => e.kind === "expired").length, 0);
});

test("a full board waits for a free office instead of overwriting one", () => {
  const state = createGame({ mode: "demo", officeCount: 2, rng: seededRandom(7) });
  run(state, 20000, 100);
  for (const office of state.offices) {
    if (office.order) assert.ok(office.order.bornAt <= state.now);
  }
  assert.ok(state.nextOrderAt > state.now - 1);
});

test("the same seed plays the same game", () => {
  const a = createGame({ mode: "demo", rng: seededRandom(42) });
  const b = createGame({ mode: "demo", rng: seededRandom(42) });
  assert.deepEqual(run(a, 30000), run(b, 30000));
});
