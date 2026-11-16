import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  REGIONS,
  postalRegion,
  regionLabel,
  zoneForPostalCode,
  zoneMatchesPostalCode,
} from "../web/postal-region.js";
import { parseShippingZones } from "./shipping.js";

describe("postalRegion", () => {
  const cases = [
    ["28014", "peninsula"],
    ["08019", "peninsula"],
    ["01001", "peninsula"],
    ["07002", "baleares"],
    ["07800", "baleares"],
    ["35001", "canarias"],
    ["38700", "canarias"],
    ["51001", "ceuta"],
    ["52001", "melilla"],
    ["52999", "melilla"],
    ["53000", null],
    ["00123", null],
    ["1000-001", "portugal"],
    ["1000001", "portugal"],
    ["  28 014 ", "peninsula"],
    ["2801", null],
    ["abc", null],
    ["", null],
  ];

  for (const [code, expected] of cases) {
    test(`${JSON.stringify(code)} -> ${expected}`, () => {
      assert.equal(postalRegion(code), expected);
    });
  }

  test("anything that is not a string is unknown", () => {
    for (const value of [null, undefined, 12345]) {
      assert.equal(postalRegion(value), null, String(value));
    }
  });
});

describe("regionLabel", () => {
  test("names every known region in Spanish", () => {
    assert.deepEqual(REGIONS.map(regionLabel), [
      "Península",
      "Baleares",
      "Canarias",
      "Ceuta",
      "Melilla",
      "Portugal",
    ]);
  });

  test("an unknown region has no label", () => {
    assert.equal(regionLabel("x"), "");
  });
});

describe("zoneForPostalCode", () => {
  const zones = [
    { id: "peninsula", region: "peninsula" },
    { id: "pt", region: "portugal" },
    { id: "bal", region: "baleares" },
  ];

  test("returns the first zone whose region matches the postal code", () => {
    assert.equal(zoneForPostalCode(zones, "07002").id, "bal");
    assert.equal(zoneForPostalCode(zones, "1000-001").id, "pt");
  });

  test("returns null when no zone serves the region", () => {
    assert.equal(zoneForPostalCode(zones, "35001"), null);
  });

  test("returns null for an unknown postal code or something that is not a list", () => {
    assert.equal(zoneForPostalCode(zones, "xx"), null);
    assert.equal(zoneForPostalCode(null, "28014"), null);
  });
});

describe("zoneMatchesPostalCode", () => {
  test("true when the zone and the postal code name the same region", () => {
    assert.equal(zoneMatchesPostalCode({ region: "baleares" }, "07002"), true);
  });

  test("false when both are known and differ", () => {
    assert.equal(zoneMatchesPostalCode({ region: "peninsula" }, "07002"), false);
  });

  test("null when either side is unknown", () => {
    assert.equal(zoneMatchesPostalCode({ id: "sin-region" }, "28014"), null);
    assert.equal(zoneMatchesPostalCode({ region: "peninsula" }, "xx"), null);
  });
});

describe("parseShippingZones regions", () => {
  test("keeps an explicit region", () => {
    const [zone] = parseShippingZones([
      { id: "zona-1", label: "Zona 1", price_cents: 700, region: "canarias" },
    ]);
    assert.deepEqual(zone, { id: "zona-1", label: "Zona 1", price_cents: 700, region: "canarias" });
  });

  test("infers the region from the id when none is given", () => {
    const [zone] = parseShippingZones([{ id: "baleares", label: "Baleares", price_cents: 1000 }]);
    assert.deepEqual(zone, { id: "baleares", label: "Baleares", price_cents: 1000, region: "baleares" });
  });

  test("leaves the region out when neither the id nor the entry names one", () => {
    const [zone] = parseShippingZones([{ id: "zona-1", label: "Zona 1", price_cents: 700 }]);
    assert.deepEqual(zone, { id: "zona-1", label: "Zona 1", price_cents: 700 });
    assert.equal("region" in zone, false);
  });

  test("an invalid region is ignored but the entry is kept", () => {
    const [zone] = parseShippingZones([
      { id: "zona-1", label: "Zona 1", price_cents: 700, region: "marte" },
    ]);
    assert.deepEqual(zone, { id: "zona-1", label: "Zona 1", price_cents: 700 });
    assert.equal("region" in zone, false);
  });

  test("the other fields are unchanged", () => {
    const [zone] = parseShippingZones([
      { id: "peninsula", label: "Península", price_cents: 700, region: "peninsula" },
    ]);
    assert.equal(zone.id, "peninsula");
    assert.equal(zone.label, "Península");
    assert.equal(zone.price_cents, 700);
  });
});
