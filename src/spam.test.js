// Tests para src/spam.js (portado de biglobster, scripts/spam.test.mjs) — los filtros de contenido de POST /api/contact.
//
// Contexto: con Turnstile activo en produccion siguieron llegando mensajes con
// nombres de letras aleatorias ("Qgnktvmn Huvkqtqx") y un bloque de letras sin
// espacios como mensaje. Esos bots consiguen tokens validos, asi que el filtro
// tiene que mirar lo que envian. Los casos "real" importan tanto como los de
// spam: un falso positivo es un cliente que escribe y nunca recibe respuesta.

import test from "node:test";
import assert from "node:assert/strict";
import { HONEYPOT_FIELD, isHoneypotFilled, looksLikeGibberish, spamReason } from "./spam.js";

test("honeypot: empty or missing is clean, any text is spam", () => {
  assert.equal(isHoneypotFilled({}), false);
  assert.equal(isHoneypotFilled({ [HONEYPOT_FIELD]: "" }), false);
  assert.equal(isHoneypotFilled({ [HONEYPOT_FIELD]: "   " }), false);
  assert.equal(isHoneypotFilled({ [HONEYPOT_FIELD]: "https://seo-deals.example" }), true);
});

// Fragmentos visibles de los dos mensajes del 2026-10-01, alargados con el
// mismo patron (Gmail corta la vista previa).
const SPAM = [
  "OYKeUKxWqbnRtLpZcVdMhJyEsQaFg",
  "bFbkdlFUxoxWNqTzRpYhcVmLsKjGd",
];

const REAL = [
  "Hola, me interesa automatizar las respuestas de WhatsApp de mi clínica. ¿Podemos hablar?",
  "Need a quote for the sales agent, annual plan.",
  "Precio?",
  "Nivel de inteligencia: Avanzado\nFacturación: anual\nAgentes: Agente de ventas (agente-ventas-anual), Agente de soporte (agente-soporte-anual)",
  "สวัสดีครับ สนใจบริการเอเจนต์ AI สำหรับร้านค้าออนไลน์",
  "我想了解你们的AI代理服务价格",
  "https://www.mi-empresa.es/servicios — queremos algo parecido",
  "WhatsApp: +34 600 123 456",
  "Mira este vídeo https://www.youtube.com/watch?v=dQwAbCdEfGhIjKlMnOp y dime",
  "Usamos SharePoint, QuickBooks y HubSpot en la oficina",
  // Un identificador pegado: 22 letras y 4 cambios de caja, pero hecho de
  // palabras reales, asi que sus vocales lo separan del ruido aleatorio.
  "El error sale en getUserByIdAndTenantId al guardar",
  "Tenemos QuickBooksOnlineAdvanced y queremos conectarlo",
];

for (const text of SPAM) {
  test(`gibberish: flags spam message ${text.slice(0, 12)}…`, () => {
    assert.equal(looksLikeGibberish(text), true);
  });
}

for (const text of REAL) {
  test(`gibberish: lets a real message through — ${text.slice(0, 30)}`, () => {
    assert.equal(looksLikeGibberish(text), false);
  });
}

test("gibberish: real names pass", () => {
  for (const name of ["Ana", "José María Fernández", "Nguyen Van Thanh", "Brais", "สมชาย ใจดี"]) {
    assert.equal(looksLikeGibberish(name), false, name);
  }
});

test("spamReason: clean submission returns ''", () => {
  assert.equal(spamReason({ name: "Ana", message: REAL[0], raw: { website: "" } }), "");
});

test("spamReason: gibberish reason names the matched run, for the log", () => {
  assert.equal(spamReason({ name: "Ana", message: `hola ${SPAM[0]}`, raw: {} }), `gibberish "${SPAM[0]}"`);
});

test("spamReason: honeypot wins before content checks", () => {
  assert.equal(spamReason({ name: "Ana", message: REAL[0], raw: { website: "x" } }), "honeypot");
});
