import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { joinLiderpapelCatalog } from "./parse.js";

// source_fingerprint decides when an owned product sheet gets pulled back for
// review, so it has two ways to be wrong and both are expensive:
//
//   too sensitive — every sheet flags within a day and the queue is noise
//   too blunt     — Liderpapel corrects a spec and our frozen sheet publishes
//                   the old number forever, which is the exact failure the
//                   whole ownership model exists to prevent
//
// These tests pin both edges: what must move the hash, and what must not.

const SUPPLIER = "TST";
const SKU = "78276";

const BASE = {
  name: "Destructora de documentos fellowes 99ci",
  description: "Destruye hasta 18 hojas. Nivel de seguridad P-4.",
  features: [
    ["Marca", "Fellowes"],
    ["Nivel de seguridad", "4"],
  ],
  documents: ["https://cdn.test/pdf/78276_SEGURIDAD.pdf"],
  gtin: "50043859629256",
  mpn: "4691001",
  priceExcTax: "100.00",
  stock: "2",
};

function fingerprintFor(overrides = {}) {
  const f = { ...BASE, ...overrides };
  const dir = mkdtempSync(join(tmpdir(), "bl-fingerprint-"));
  const write = (name, data) => {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(data));
    return path;
  };

  const paths = {
    catalog: write("Catalog.json", {
      root: {
        Products: [
          {
            supplierCode: SUPPLIER,
            Product: [
              {
                id: SKU,
                Status: "VAL",
                Validity: "1",
                References: {
                  Reference: [
                    { RefType: "FABRICANTE_GENERICO", RefCode: f.mpn },
                    { RefType: "EAN_UNIDAD", RefCode: f.gtin },
                  ],
                },
                Features: {
                  Feature: f.features.map(([FeatureName, Value]) => ({
                    lang: "es-ES",
                    FeatureName,
                    Value,
                  })),
                },
                Classifications: {
                  Classification: [{ Level: "1", ClassDescription: "Máquinas de oficina" }],
                },
                AdditionalInfo: { Weight: "21760.0" },
              },
            ],
          },
        ],
      },
    }),
    descriptions: write("Descriptions.json", {
      root: {
        Products: [
          {
            supplierCode: SUPPLIER,
            Product: [
              {
                id: SKU,
                Descriptions: {
                  Description: [
                    { DescCode: "INT_VTE", Texts: { Text: [{ Value: f.name }] } },
                    { DescCode: "AMPL_DESC", Texts: { Text: [{ Value: f.description }] } },
                  ],
                },
              },
            ],
          },
        ],
      },
    }),
    prices: write("Prices.json", {
      root: {
        Products: [
          {
            supplierCode: SUPPLIER,
            Product: [
              {
                id: SKU,
                Prices: [
                  {
                    Price: [
                      {
                        priceType: "purchase",
                        PriceLines: { PriceLine: [{ PriceExcTax: f.priceExcTax }] },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    }),
    multimedia: write("MultimediaLinks.json", {
      root: {
        Products: [
          {
            supplierCode: SUPPLIER,
            Product: [
              {
                id: SKU,
                MultimediaLinks: {
                  MultimediaLink: [
                    { mmlType: "IMG", Name: "g.jpg", Url: "https://cdn.test/g.jpg", Active: "1" },
                    ...f.documents.map((Url) => ({
                      mmlType: "DOC",
                      Name: Url.split("/").pop(),
                      Url,
                      Active: "1",
                    })),
                  ],
                },
              },
            ],
          },
        ],
      },
    }),
    stocks: write("Stocks.json", {
      root: {
        Storage: [
          {
            supplierCode: SUPPLIER,
            Stocks: [
              {
                Products: { Product: [{ id: SKU, Stock: [{ AvailableQuantity: f.stock }] }] },
              },
            ],
          },
        ],
      },
    }),
  };

  const products = joinLiderpapelCatalog(paths, {
    supplierCode: SUPPLIER,
    marginPct: 0.4,
    vatRate: 0.21,
  });
  return products.get(SKU).row.source_fingerprint;
}

const BASELINE = fingerprintFor();

describe("source_fingerprint — what must NOT disturb an owned sheet", () => {
  test("is stable across identical feeds", () => {
    assert.equal(fingerprintFor(), BASELINE);
  });

  test("ignores a price change", () => {
    // Prices refresh every 12h upstream. If they moved the hash, every owned
    // sheet in the catalogue would be flagged for review twice a day.
    assert.equal(fingerprintFor({ priceExcTax: "250.00" }), BASELINE);
  });

  test("ignores a stock change", () => {
    // Stock refreshes every 10 minutes. Same reasoning, more so.
    assert.equal(fingerprintFor({ stock: "0" }), BASELINE);
  });
});

describe("source_fingerprint — what must pull a sheet back for review", () => {
  test("a corrected specification", () => {
    // The case the whole mechanism exists for: Fellowes restates the security
    // level and our frozen sheet would otherwise keep publishing "4".
    assert.notEqual(
      fingerprintFor({ features: [["Marca", "Fellowes"], ["Nivel de seguridad", "5"]] }),
      BASELINE,
    );
  });

  test("a rewritten description", () => {
    assert.notEqual(
      fingerprintFor({ description: "Destruye hasta 12 hojas. Nivel de seguridad P-5." }),
      BASELINE,
    );
  });

  test("a retitled product", () => {
    assert.notEqual(fingerprintFor({ name: "Destructora Fellowes 99Ci automática" }), BASELINE);
  });

  test("a new document appearing", () => {
    assert.notEqual(
      fingerprintFor({
        documents: [...BASE.documents, "https://cdn.test/pdf/78276_MANUAL.pdf"],
      }),
      BASELINE,
    );
  });

  test("a document withdrawn", () => {
    assert.notEqual(fingerprintFor({ documents: [] }), BASELINE);
  });

  test("a corrected barcode", () => {
    assert.notEqual(fingerprintFor({ gtin: "50043859629999" }), BASELINE);
  });

  test("a dropped feature, even when the remaining ones are unchanged", () => {
    assert.notEqual(fingerprintFor({ features: [["Marca", "Fellowes"]] }), BASELINE);
  });
});

describe("source_fingerprint — no collisions from field boundaries", () => {
  test("moving text across a feature's name/value boundary changes the hash", () => {
    // Naive concatenation would hash {"Nivel", "de seguridad 4"} and
    // {"Nivel de seguridad", "4"} identically, and a real spec correction that
    // only reshuffles a label would slip through unnoticed.
    const a = fingerprintFor({ features: [["Nivel de seguridad", "4"]] });
    const b = fingerprintFor({ features: [["Nivel", "de seguridad 4"]] });
    assert.notEqual(a, b);
  });

  test("splitting one feature into two changes the hash", () => {
    const one = fingerprintFor({ features: [["Marca", "FellowesNivel"]] });
    const two = fingerprintFor({ features: [["Marca", "Fellowes"], ["Nivel", ""]] });
    assert.notEqual(one, two);
  });
});
