import { test } from "node:test";
import assert from "node:assert/strict";
import { renderAccentWord, stripAccentWord } from "./accent-word.js";

test("a plain title renders escaped and unchanged otherwise", () => {
  assert.equal(renderAccentWord("Bienvenidos a nuestra empresa"), "Bienvenidos a nuestra empresa");
  assert.equal(renderAccentWord('Tornillos <b>& más</b>'), "Tornillos &lt;b&gt;&amp; más&lt;/b&gt;");
  assert.equal(renderAccentWord(undefined), "");
});

test("the first *word* becomes the accent span, later marks are unwrapped", () => {
  assert.equal(
    renderAccentWord("Sonríe con *tranquilidad* y *calma*"),
    'Sonríe con <span class="accent-word">tranquilidad</span> y calma',
  );
});

test("the marked word is escaped too", () => {
  assert.equal(renderAccentWord("*<x>*"), '<span class="accent-word">&lt;x&gt;</span>');
});

test("an unclosed or empty mark is left alone", () => {
  assert.equal(renderAccentWord("5* de descuento"), "5* de descuento");
  assert.equal(renderAccentWord("a ** b"), "a ** b");
});

test("stripAccentWord removes every mark for titles, meta and the bot", () => {
  assert.equal(stripAccentWord("Sonríe con *tranquilidad* y *calma*"), "Sonríe con tranquilidad y calma");
  assert.equal(stripAccentWord(null), "");
});
