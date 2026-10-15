import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addText1Spans,
  formatInEffect,
  parse,
  serialize,
} from "./format-string.ts";

test("round trip", () => {
  const original = "⸨format1⸩content1⸨format2⸩content2⸨format3⸩content3";
  assert.equal(serialize(parse(original)), original);
});

test("each unit is one caret position", () => {
  assert.deepEqual(parse("⸨a⸩xy⸨b⸩"), [
    { format: "a" },
    "x",
    "y",
    { format: "b" },
  ]);
});

test("pasting a fragment without a leading format", () => {
  assert.deepEqual(parse("hi⸨b⸩"), ["h", "i", { format: "b" }]);
});

test("unmatched brackets are dropped", () => {
  assert.equal(serialize(parse("⸨a⸩x⸨y⸩z⸩w⸨")), "⸨a⸩x⸨y⸩zw");
});

test("empty and unusual names survive", () => {
  const original = "⸨⸩empty name⸨ spaced ⸩⸨emoji 🎨⸩text";
  assert.equal(serialize(parse(original)), original);
});

test("line endings are normalized", () => {
  assert.equal(serialize(parse("⸨a⸩1\r\n2\r3")), "⸨a⸩1\n2\n3");
});

test("surrogate pairs count as two units, like the DOM", () => {
  assert.equal(parse("🎨").length, 2);
});

test("formatInEffect", () => {
  const units = parse("⸨a⸩xy⸨b⸩z");
  assert.equal(formatInEffect(units, 0), undefined);
  assert.equal(formatInEffect(units, 1), "a");
  assert.equal(formatInEffect(units, 3), "a");
  assert.equal(formatInEffect(units, 4), "b");
  assert.equal(formatInEffect(units, 99), "b");
});

test("addText1Spans matches addText1()", () => {
  assert.deepEqual(addText1Spans("⸨a⸩x\ny⸨b⸩⸨c⸩z"), [
    { format: "a", content: "x\ny" },
    { format: "b", content: "" },
    { format: "c", content: "z" },
  ]);
  assert.throws(() => addText1Spans("no leading format"));
  assert.deepEqual(addText1Spans(""), []);
});
