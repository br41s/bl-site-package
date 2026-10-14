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

// price_cents = round(pvo_ex_vat * (1 + adjust) * (1 + vat) * 100)
//
// The public price is the distributor's suggested retail price for its general
// catalogue — priceType "suggestedCI", the "catálogo integral" PVO, confirmed
// as the general one by Liderpapel support on 2026-10-13 — at the product's
// own VAT rate (VATRates in the prices file: 21 % on most of the catalogue,
// 4 % on books, 10 % on a few). The adjustment is ours: a general percentage
// over the PVO in the "liderpapel_pvo_adjust_pct" config key (0 = the
// catalogue price, negative undercuts it) and an optional one per category
// (src/api/pricing.js). A product the feed gives no PVO for (13 of Shoroban's
// 14,487 on 2026-08-19) is priced from its purchase cost at DEFAULT_MARGIN_PCT
// instead. Brais decided on 2026-10-14 that the site sells at the catalogue
// price: a Calipage shop's customers compare against the printed catalogue.
export const DEFAULT_PVO_ADJUST_PCT = 0;
export const DEFAULT_MARGIN_PCT = 40;
export const DEFAULT_VAT_RATE = 0.21;
