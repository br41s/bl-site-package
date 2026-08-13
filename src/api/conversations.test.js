import { test } from "node:test";
import assert from "node:assert/strict";
import { maskPhone, computeWindowState } from "./conversations.js";

test("maskPhone keeps country code and last 3 digits only", () => {
  assert.equal(maskPhone("+34600111222"), "+34 ••• ••• 222");
});

test("maskPhone handles missing input safely", () => {
  assert.equal(maskPhone(undefined), "(sin número)");
  assert.equal(maskPhone(""), "(sin número)");
});

test("computeWindowState: within window right after an inbound message", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const messages = [{ message_type: "incoming", created_at: nowSec - 60 }];
  const result = computeWindowState(messages, Date.now());
  assert.equal(result.withinWindow, true);
  assert.ok(result.msRemaining > 0);
});

test("computeWindowState: lapsed after more than 24h since the last inbound message", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const messages = [{ message_type: "incoming", created_at: nowSec - 25 * 60 * 60 }];
  const result = computeWindowState(messages, Date.now());
  assert.equal(result.withinWindow, false);
  assert.equal(result.msRemaining, 0);
});

test("computeWindowState: ignores outgoing messages, only counts inbound", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const messages = [
    { message_type: "incoming", created_at: nowSec - 25 * 60 * 60 },
    { message_type: "outgoing", created_at: nowSec - 60 }, // recent, but not inbound
  ];
  const result = computeWindowState(messages, Date.now());
  assert.equal(result.withinWindow, false);
});

test("computeWindowState: no messages at all -> not within window", () => {
  const result = computeWindowState([], Date.now());
  assert.equal(result.withinWindow, false);
  assert.equal(result.lastInboundAt, null);
});

test("computeWindowState: picks the most recent inbound message when several exist", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const messages = [
    { message_type: "incoming", created_at: nowSec - 25 * 60 * 60 }, // stale
    { message_type: "incoming", created_at: nowSec - 60 }, // fresh
  ];
  const result = computeWindowState(messages, Date.now());
  assert.equal(result.withinWindow, true);
});
