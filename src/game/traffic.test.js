// The difficulty curve lives in web/game/traffic.js (shipped to the browser as
// a passthrough file); its test lives here so it is never copied to _site.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ordersPerMinute,
  START_ORDERS_PER_MINUTE,
  MAX_ORDERS_PER_MINUTE,
} from "../../web/game/traffic.js";

const MINUTE = 60000;

test("starts at the opening rate", () => {
  assert.equal(ordersPerMinute(0), START_ORDERS_PER_MINUTE);
});

test("never slows down and never passes the cap", () => {
  let previous = ordersPerMinute(0);
  for (let ms = 0; ms <= 120 * MINUTE; ms += 1000) {
    const rate = ordersPerMinute(ms);
    assert.ok(
      rate >= previous,
      `rate dropped at ${ms} ms: ${previous} -> ${rate}`,
    );
    assert.ok(
      rate <= MAX_ORDERS_PER_MINUTE,
      `rate ${rate} over the cap at ${ms} ms`,
    );
    previous = rate;
  }
});

test("is busier after five minutes than at the start", () => {
  assert.ok(ordersPerMinute(5 * MINUTE) > START_ORDERS_PER_MINUTE);
});

test("is always a positive finite rate (0 or NaN would stop orders for good)", () => {
  for (let ms = 0; ms <= 120 * MINUTE; ms += 30000) {
    const rate = ordersPerMinute(ms);
    assert.ok(
      Number.isFinite(rate) && rate > 0,
      `bad rate ${rate} at ${ms} ms`,
    );
  }
});
