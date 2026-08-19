// Verified against a real sample pulled from Shoroban's live Liderpapel sFTP
// account (fixtures/liderpapel/, dated 2026-08-19). Catalog, Descriptions,
// Prices and MultimediaLinks share one shape: root.Products[] -> per-supplier
// blocks ({ supplierCode, date, Product: [...] }), joined by numeric `id`.
// Stocks is shaped differently: root.Storage[] -> per-supplier warehouse
// blocks ({ supplierCode, date, Stocks: [...] }), each Stocks[] entry a
// warehouse with its own Products.Product[].
//
// Liderpapel groups several brands under one sFTP account (e.g. CSP, GC2,
// GC3, GC4, GC5 all appear in Shoroban's feed) — the right code is per
// customer, not a package-wide constant. Read from the "liderpapel_supplier_code"
// config key (see database.js / sync.js); this is only a last-resort fallback
// for local/dev use, deliberately NOT Shoroban's own code ("CSP").
export const DEFAULT_SUPPLIER_CODE = "";

// Only "VAL" (currently valid/sellable) products are synced. "FUT" (upcoming,
// not yet orderable) and "INV" (discontinued) are excluded for Fase 1.
export const SELLABLE_STATUS = "VAL";

// Real filenames are "<Name>_es_ES_<accountCode>.json" — matched by prefix
// (see client.js's resolveFeedFiles()) since the suffix is account-specific.
// RelationedProducts (variant/family grouping, ~200MB) is deliberately not
// listed here — it's not ingested in Fase 1, see parse.js.
export const FILENAME_PREFIXES = {
  catalog: "Catalog",
  prices: "Prices",
  stocks: "Stocks",
  descriptions: "Descriptions",
  multimedia: "MultimediaLinks",
};

// DescCode used for the product title and long body description.
export const TITLE_DESC_CODE = "INT_VTE"; // "Título del producto"
export const BODY_DESC_CODE = "AMPL_DESC"; // "Descripción ampliada"

// price_cents = round(purchase_price_ex_vat * (1 + margin) * (1 + vat) * 100)
// Margin is configurable via the "liderpapel_margin_pct" config key (see
// database.js); this is only the fallback default. VAT is fixed at the feed's
// documented Spanish rate (also present per-product under Prices.VATRates).
export const DEFAULT_MARGIN = 0.4;
export const DEFAULT_VAT_RATE = 0.21;
