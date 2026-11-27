import assert from "node:assert/strict";
import test from "node:test";
import { csvCell, toCsv } from "../src/lib/csv";

test("csvCell quotes commas, quotes and newlines", () => {
  assert.equal(csvCell("a,b"), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell("line1\nline2"), '"line1\nline2"');
  assert.equal(csvCell(null), "");
});

test("csvCell neutralises spreadsheet formulas", () => {
  assert.equal(csvCell("=1+1"), "'=1+1");
  assert.equal(csvCell("+cmd"), "'+cmd");
  assert.equal(csvCell("@SUM(A1)"), "'@SUM(A1)");
  assert.equal(csvCell("-2+3"), "'-2+3");
});

test("csvCell leaves plain numbers and dates intact", () => {
  assert.equal(csvCell(-12), "-12");
  assert.equal(csvCell("-12.5"), "-12.5");
  assert.equal(csvCell(new Date("2026-01-02T03:04:05Z")), "2026-01-02T03:04:05.000Z");
});

test("toCsv joins rows with CRLF by default", () => {
  assert.equal(toCsv(["A", "B"], [[1, "x,y"]]), 'A,B\r\n1,"x,y"');
});
