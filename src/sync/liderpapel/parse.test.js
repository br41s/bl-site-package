import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { joinLiderpapelCatalog } from "./parse.js";

// Fixtures mirror the real feed's shape (verified against Shoroban's account,
// 2026-08-19) but are written here rather than committed: fixtures/liderpapel/
// is gitignored because real feed files are customer data and ~100MB each.
const SUPPLIER = "TST";

// 1: everything present — AMPL_DESC body, features, both identifier types,
//    several images, a document.
// 2: no AMPL_DESC — the case that left ~3,200 of Shoroban's pages blank.
//    Also carries only packaging EANs, no EAN_UNIDAD.
// 3: discontinued (Status INV) — must not be synced at all.
const CATALOG = {
  root: {
    Products: [
      {
        supplierCode: SUPPLIER,
        date: "2026-08-19",
        Product: [
          {
            id: "78276",
            Status: "VAL",
            Validity: "1",
            References: {
              Reference: [
                { RefType: "FABRICANTE_GENERICO", RefCode: "4691001" },
                { RefType: "EAN_EMBALAJE", RefCode: "50043859629999" },
                { RefType: "EAN_UNIDAD", RefCode: "50043859629256" },
              ],
            },
            Features: {
              Feature: [
                { lang: "es-ES", FeatureName: "Marca", Value: "Fellowes" },
                { lang: "es-ES", FeatureName: "Tipo", Value: "Destructora" },
                { lang: "es-ES", FeatureName: "Nivel de seguridad", Value: "4" },
                { lang: "es-ES", FeatureName: "Sin valor", Value: "" },
              ],
            },
            Classifications: {
              Classification: [
                { Level: "1", ClassDescription: "Máquinas de oficina" },
                { Level: "2", ClassDescription: "Destructoras de documentos" },
              ],
            },
            AdditionalInfo: {
              Weight: "21760.0",
              LogisticInfo: { LogisticUMV: { Dimensions: "706x522x368" } },
            },
          },
          {
            id: "28224",
            Status: "VAL",
            Validity: "1",
            References: {
              Reference: [{ RefType: "EAN_UMV", RefCode: "8412345678905" }],
            },
            Features: {
              Feature: [{ lang: "es-ES", FeatureName: "Marca", Value: "Liderpapel" }],
            },
            Classifications: { Classification: [{ Level: "1", ClassDescription: "Papelería" }] },
            AdditionalInfo: { Weight: "0.0" },
          },
          {
            id: "905961",
            Status: "INV",
            Validity: "0",
            References: { Reference: [{ RefType: "EAN_UNIDAD", RefCode: "8423473140325" }] },
            Features: { Feature: [] },
            Classifications: { Classification: [] },
            AdditionalInfo: {},
          },
          // Sellable, but the feed gives it no price at all.
          {
            id: "77777",
            Status: "VAL",
            Validity: "1",
            References: { Reference: [] },
            Features: { Feature: [] },
            Classifications: { Classification: [] },
            AdditionalInfo: {},
          },
        ],
      },
      // A second supplier block, synced only when its code is configured.
      {
        supplierCode: "OTHER",
        date: "2026-08-19",
        Product: [
          {
            id: "99999",
            Status: "VAL",
            Validity: "1",
            References: { Reference: [] },
            Features: { Feature: [] },
            Classifications: { Classification: [] },
            AdditionalInfo: {},
          },
        ],
      },
    ],
  },
};

function desc(id, entries) {
  return {
    id,
    Descriptions: {
      Description: entries.map(([DescCode, Value]) => ({
        DescCode,
        Texts: { Text: [{ lang: "es-ES", Value }] },
      })),
    },
  };
}

const DESCRIPTIONS = {
  root: {
    Products: [
      {
        supplierCode: SUPPLIER,
        Product: [
          desc("78276", [
            ["INT_VTE", "Destructora de documentos fellowes 99ci"],
            ["AMPL_DESC", "<p>Destructora profesional.</p>"],
            ["TXT_RCOM", "Destruye hasta 18 hojas."],
          ]),
          desc("28224", [
            ["INT_VTE", "Tarjeta de visita liderpapel blanca 90x60mm"],
            ["TXT_RCOM", "Envase de plástico rígido. La caja con 100 unidades."],
            ["INT_RCOM_CRT", "Pinche sobre la descripción para visualizar la Oferta del mes"],
          ]),
        ],
      },
    ],
  },
};

const PRICES = {
  root: {
    Products: [
      {
        supplierCode: SUPPLIER,
        Product: [
          // Quantity tiers come largest pack first, with the unit line last:
          // 10 at 100.00, 1 at 120.00 (the below-pack supplement included).
          // A second suggested price (suggestedSco, the school catalogue)
          // rides along, as in the real feed — only suggestedCI is the PVO.
          {
            id: "78276",
            Prices: [
              {
                Price: [
                  {
                    priceType: "purchase",
                    PriceLines: {
                      PriceLine: [
                        { PriceExcTax: "100.00", MinQuantity: "10" },
                        { PriceExcTax: "120.00", MinQuantity: "1" },
                      ],
                    },
                  },
                  {
                    priceType: "suggestedSco",
                    PriceLines: { PriceLine: [{ PriceExcTax: "190.00" }] },
                  },
                  {
                    priceType: "suggestedCI",
                    PriceLines: { PriceLine: [{ PriceExcTax: "200.00" }] },
                  },
                ],
              },
            ],
            VATRates: { VATRate: [{ country: "ES", Value: "21.0" }] },
          },
          // No PVO, reduced VAT (a book): priced from cost at the fallback margin.
          {
            id: "28224",
            Prices: [
              {
                Price: [
                  {
                    priceType: "purchase",
                    PriceLines: { PriceLine: [{ PriceExcTax: "2.00" }] },
                  },
                ],
              },
            ],
            VATRates: { VATRate: [{ country: "ES", Value: "4.0" }] },
          },
        ],
      },
      {
        supplierCode: "OTHER",
        Product: [
          {
            id: "99999",
            Prices: [
              {
                Price: [
                  {
                    priceType: "purchase",
                    PriceLines: { PriceLine: [{ PriceExcTax: "1.00" }] },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
};

const MULTIMEDIA = {
  root: {
    Products: [
      {
        supplierCode: SUPPLIER,
        Product: [
          {
            id: "78276",
            MultimediaLinks: {
              MultimediaLink: [
                { mmlType: "IMG", Name: "78276g.jpg", Url: "https://cdn.test/78276g.jpg", Active: "1" },
                { mmlType: "IMG", Name: "78276p.jpg", Url: "https://cdn.test/78276p.jpg", Active: "1" },
                // Duplicate of the first — the real feed repeats URLs.
                { mmlType: "IMG", Name: "78276g.jpg", Url: "https://cdn.test/78276g.jpg", Active: "1" },
                // Inactive with an empty Url — the real feed pads with these.
                { mmlType: "IMG", Name: "", Url: "", Active: "0" },
                { mmlType: "VIDEO", Name: "", Url: "", Active: "0" },
                {
                  mmlType: "DOC",
                  Name: "78276_DESTRUCTORA_FELLOWES_SEGURIDAD.pdf",
                  Url: "https://cdn.test/pdf/78276_DESTRUCTORA_FELLOWES_SEGURIDAD.pdf",
                  Active: "1",
                },
                { mmlType: "DOC", Name: "inactivo.pdf", Url: "https://cdn.test/pdf/no.pdf", Active: "0" },
              ],
            },
          },
          {
            id: "28224",
            MultimediaLinks: {
              MultimediaLink: [
                { mmlType: "IMG", Name: "", Url: "", Active: "0" },
              ],
            },
          },
        ],
      },
    ],
  },
};

const STOCKS = {
  root: {
    Storage: [
      {
        supplierCode: SUPPLIER,
        Stocks: [
          {
            code: "1",
            name: "ALMACEN-A",
            Products: { Product: [{ id: "78276", Stock: [{ AvailableQuantity: "2" }] }] },
          },
          {
            code: "2",
            name: "ALMACEN-B",
            Products: {
              Product: [
                { id: "78276", Stock: [{ AvailableQuantity: "3" }] },
                { id: "28224", Stock: [{ AvailableQuantity: "0" }] },
              ],
            },
          },
        ],
      },
    ],
  },
};

let paths;

before(() => {
  const dir = mkdtempSync(join(tmpdir(), "bl-liderpapel-parse-"));
  const write = (name, data) => {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(data));
    return path;
  };
  paths = {
    catalog: write("Catalog.json", CATALOG),
    descriptions: write("Descriptions.json", DESCRIPTIONS),
    prices: write("Prices.json", PRICES),
    multimedia: write("MultimediaLinks.json", MULTIMEDIA),
    stocks: write("Stocks.json", STOCKS),
  };
});

function parse(adjustFor = () => 0) {
  return joinLiderpapelCatalog(paths, { supplierCode: SUPPLIER, adjustFor });
}

describe("joinLiderpapelCatalog", () => {
  test("syncs only VAL products from the configured supplier block", () => {
    const products = parse();
    assert.deepEqual([...products.keys()].sort(), ["28224", "78276"]);
  });

  test("merges every configured supplier block, comma-separated", () => {
    // Shoroban's feed carries CSP plus four brand blocks it can order from
    // on the same terms; each is a block of its own in every file.
    const products = joinLiderpapelCatalog(paths, { supplierCode: " TST, OTHER ," });
    assert.deepEqual([...products.keys()].sort(), ["28224", "78276", "99999"]);
    // A block with no descriptions or stocks still yields a row, not a throw.
    assert.equal(products.get("99999").row.price_cents, 169); // 1.00 × 1.4 × 1.21
    assert.equal(products.get("99999").row.stock_qty, 0);
  });

  test("a sellable product the feed gives no price for is not published", () => {
    // It would otherwise go live at 0,00 € and could be reserved for nothing.
    assert.equal(parse().has("77777"), false);
  });

  test("an empty code list is refused, not an empty catalogue", () => {
    assert.throws(() => joinLiderpapelCatalog(paths, { supplierCode: " , " }), /no configurado/);
  });

  test("keeps the existing row shape: price, stock and primary image", () => {
    const { row } = parse().get("78276");
    // The PVO as is: 200.00 suggestedCI * 1.21 VAT = 242.00
    assert.equal(row.price_cents, 24200);
    // Stock is summed across warehouses.
    assert.equal(row.stock_qty, 5);
    assert.equal(row.image_url, "https://cdn.test/78276g.jpg");
    assert.equal(row.category, "Destructoras de documentos");
    assert.equal(row.slug, "78276-destructora-de-documentos-fellowes-99ci");
  });

  test("prices from the PVO with the category's adjustment, at the product's VAT", () => {
    const products = parse((category) => (category === "Destructoras de documentos" ? -5 : 0));
    const { row } = products.get("78276");
    // 200.00 PVO * 0.95 * 1.21 VAT = 229.90
    assert.equal(row.price_cents, 22990);
    assert.equal(row.pvo_ex_vat, 200);
    assert.equal(row.vat_rate, 0.21);
  });

  test("the cost is the smallest quantity tier, not the first line", () => {
    // 10 units at 100.00 is listed first; the shop buys singles at 120.00.
    assert.equal(parse().get("78276").row.cost_ex_vat, 120);
  });

  test("without a PVO, prices from cost at the fallback margin and the product's VAT", () => {
    const { row } = parse(() => -5).get("28224");
    assert.equal(row.pvo_ex_vat, null);
    assert.equal(row.vat_rate, 0.04);
    // 2.00 cost * 1.4 fallback margin * 1.04 VAT = 2.912 → 291; the adjustment
    // is over the PVO and does not apply here.
    assert.equal(row.price_cents, 291);
  });

  test("extracts the unit EAN and the manufacturer reference", () => {
    const { row } = parse().get("78276");
    assert.equal(row.gtin, "50043859629256");
    assert.equal(row.mpn, "4691001");
  });

  test("never takes a packaging EAN as the product's identifier", () => {
    // 28224 carries only EAN_UMV. Accepting it would identify a box of 100
    // as if it were the single unit the customer buys.
    const { row } = parse().get("28224");
    assert.equal(row.gtin, null);
  });

  test("promotes the brand out of the feature list", () => {
    assert.equal(parse().get("78276").row.brand, "Fellowes");
  });

  test("keeps features in feed order and drops empty values", () => {
    const { features } = parse().get("78276");
    assert.deepEqual(features, [
      { name: "Marca", value: "Fellowes" },
      { name: "Tipo", value: "Destructora" },
      { name: "Nivel de seguridad", value: "4" },
    ]);
  });

  test("reads weight and packed dimensions from AdditionalInfo", () => {
    const { row } = parse().get("78276");
    assert.equal(row.weight_grams, 21760);
    assert.equal(row.dimensions_mm, "706x522x368");
    // A zero weight is absence, not a fact worth printing.
    assert.equal(parse().get("28224").row.weight_grams, null);
  });

  test("prefers AMPL_DESC for the body when it exists", () => {
    assert.equal(parse().get("78276").row.description, "<p>Destructora profesional.</p>");
  });

  test("falls back to TXT_RCOM when AMPL_DESC is missing", () => {
    assert.equal(
      parse().get("28224").row.description,
      "Envase de plástico rígido. La caja con 100 unidades.",
    );
  });

  test("never falls back to the INT_RCOM_CRT promo boilerplate", () => {
    const { row } = parse().get("28224");
    assert.ok(!row.description.includes("Pinche sobre la descripción"));
  });

  test("collects active images, deduplicated and in order", () => {
    assert.deepEqual(parse().get("78276").images, [
      "https://cdn.test/78276g.jpg",
      "https://cdn.test/78276p.jpg",
    ]);
    assert.deepEqual(parse().get("28224").images, []);
  });

  test("collects active documents with their filename label", () => {
    assert.deepEqual(parse().get("78276").documents, [
      {
        url: "https://cdn.test/pdf/78276_DESTRUCTORA_FELLOWES_SEGURIDAD.pdf",
        label: "78276_DESTRUCTORA_FELLOWES_SEGURIDAD.pdf",
      },
    ]);
    assert.deepEqual(parse().get("28224").documents, []);
  });
});
