import { test } from "node:test";
import assert from "node:assert/strict";
import { formatIban, isValidBic, isValidIban } from "./iban.js";

test("IBANs pass only when their check digits add up", () => {
  assert.equal(isValidIban("ES43 0182 4731 8402 0160 5267"), true);
  assert.equal(isValidIban("es4301824731840201605267"), true);
  assert.equal(isValidIban("GB82WEST12345698765432"), true);
  // One digit off, two digits swapped, truncated, junk.
  assert.equal(isValidIban("ES4301824731840201605268"), false);
  assert.equal(isValidIban("ES4301824731840201605276"), false);
  assert.equal(isValidIban("ES43018247318402"), false);
  assert.equal(isValidIban("not an iban"), false);
  assert.equal(isValidIban(""), false);
});

test("BICs are 8 or 11 characters", () => {
  assert.equal(isValidBic("BBVAESMMXXX"), true);
  assert.equal(isValidBic("bbvaesmm"), true);
  assert.equal(isValidBic("BBVAESM"), false);
  assert.equal(isValidBic("BBVAESMMXX"), false);
});

test("IBANs are shown in groups of four", () => {
  assert.equal(formatIban("es43 0182473184 0201605267"), "ES43 0182 4731 8402 0160 5267");
});
