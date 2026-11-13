import { test } from "node:test";
import assert from "node:assert/strict";
import { shopPaymentLine, shopHeroLine } from "./shop-lines.js";

const NO_ZONES = [];

test("the short line says card, transfer, both or neither", () => {
  assert.equal(
    shopPaymentLine({ bankIban: "ES00 0000 0000 0000 0000 0000", cardPayments: true }),
    "Pide online y paga con tarjeta o por transferencia bancaria",
  );
  assert.equal(shopPaymentLine({ bankIban: "", cardPayments: true }), "Pide online y paga con tarjeta");
  assert.equal(
    shopPaymentLine({ bankIban: "ES00 0000 0000 0000 0000 0000", cardPayments: false }),
    "Pide online y paga por transferencia bancaria",
  );
  assert.equal(shopPaymentLine({ bankIban: "", cardPayments: false }), "Pide online y paga al recibir tu pedido");
});

test("the hero names the products and how to pay, with no delivery when no zones are set", () => {
  assert.equal(
    shopHeroLine({ bankIban: "ES00 0000 0000 0000 0000 0000", cardPayments: false }),
    "Elige tus productos y pídelos online en pocos clics. Paga por transferencia bancaria.",
  );
  assert.equal(
    shopHeroLine({ bankIban: "", cardPayments: false, zones: NO_ZONES }),
    "Elige tus productos y pídelos online en pocos clics. Paga al recibir tu pedido.",
  );
});

test("the hero says card when card payments are on", () => {
  assert.equal(
    shopHeroLine({ bankIban: "", cardPayments: true, zones: NO_ZONES }),
    "Elige tus productos y pídelos online en pocos clics. Paga con tarjeta.",
  );
});

test("the hero splits free and paid zones, the Shoroban case", () => {
  assert.equal(
    shopHeroLine({
      bankIban: "ES00 0000 0000 0000 0000 0000",
      cardPayments: false,
      zones: [
        { id: "ourense", label: "Ourense ciudad", price_cents: 0 },
        { id: "peninsula", label: "Península", price_cents: 700 },
        { id: "portugal", label: "Portugal", price_cents: 1400 },
        { id: "baleares", label: "Baleares", price_cents: 1000 },
      ],
    }),
    "Elige tus productos y pídelos online en pocos clics. Paga por transferencia bancaria. Envío gratis en Ourense ciudad y también enviamos a Península, Portugal y Baleares.",
  );
});

test("only free zones are announced as free", () => {
  assert.equal(
    shopHeroLine({
      bankIban: "",
      cardPayments: false,
      zones: [
        { id: "ourense", label: "Ourense ciudad", price_cents: 0 },
        { id: "comarca", label: "Comarca", price_cents: 0 },
      ],
    }),
    "Elige tus productos y pídelos online en pocos clics. Paga al recibir tu pedido. Envío gratis en Ourense ciudad y Comarca.",
  );
});

test("a single paid zone needs no list separator", () => {
  assert.equal(
    shopHeroLine({ bankIban: "", cardPayments: false, zones: [{ id: "peninsula", label: "Península", price_cents: 700 }] }),
    "Elige tus productos y pídelos online en pocos clics. Paga al recibir tu pedido. Enviamos a Península.",
  );
});

test("two paid zones join with y", () => {
  assert.equal(
    shopHeroLine({
      bankIban: "",
      cardPayments: false,
      zones: [
        { id: "peninsula", label: "Península", price_cents: 700 },
        { id: "baleares", label: "Baleares", price_cents: 1000 },
      ],
    }),
    "Elige tus productos y pídelos online en pocos clics. Paga al recibir tu pedido. Enviamos a Península y Baleares.",
  );
});