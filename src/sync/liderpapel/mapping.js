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

// Liderpapel only writes AMPL_DESC for part of the catalog — on Shoroban's
// feed, 11,274 of 14,487 sellable products. The rest arrived with an empty
// description, which is what made their product pages look unpopulated.
// TXT_RCOM ("Descriptivo") is a shorter but genuine factual descriptor and
// covers most of the remainder, so it stands in when AMPL_DESC is absent.
// It is plain text where AMPL_DESC is HTML; both render fine through the
// site's marked + sanitize-html pipeline (see site/_data/products.js).
export const FALLBACK_BODY_DESC_CODE = "TXT_RCOM";

// INT_RCOM_CRT ("Título de Oferta") is deliberately NOT used as a fallback:
// it holds promo boilerplate aimed at Liderpapel's own storefront, e.g.
// "Pinche sobre la descripción para visualizar los detalles de la Oferta del
// mes", which is meaningless on a customer's site.

// RefType values used as product identifiers (spec §2.6, p.25).
//
// EAN_UNIDAD is the barcode of the sellable unit. The other EAN_* types
// describe packaging levels — EAN_UMV is the minimum sales unit, EAN_EMBALAJE
// the outer box, EAN_PALET the pallet — so matching a product on those would
// pair a single unit against a box of 100. Only EAN_UNIDAD identifies the
// thing the customer receives.
export const GTIN_REF_TYPE = "EAN_UNIDAD";
export const MPN_REF_TYPE = "FABRICANTE_GENERICO"; // manufacturer's own reference

// Feature carrying the brand. Promoted out of the generic feature list
// because it is the one attribute needed on its own (schema.org/brand).
export const BRAND_FEATURE_NAME = "Marca";

// MultimediaLinks mmlType values. VIDEO also exists in the feed but every
// entry on Shoroban's account is inactive with an empty Url, so it is not
// ingested.
export const IMAGE_MML_TYPE = "IMG";
export const DOCUMENT_MML_TYPE = "DOC"; // datasheets, safety sheets, manuals

// price_cents = round(purchase_price_ex_vat * (1 + margin) * (1 + vat) * 100)
// Margin is configurable via the "liderpapel_margin_pct" config key (see
// database.js); this is only the fallback default. VAT is fixed at the feed's
// documented Spanish rate (also present per-product under Prices.VATRates).
export const DEFAULT_MARGIN = 0.4;
export const DEFAULT_VAT_RATE = 0.21;
