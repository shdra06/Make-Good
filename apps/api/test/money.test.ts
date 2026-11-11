import assert from "node:assert/strict";
import { test } from "node:test";
import {
  allocate,
  divideRounded,
  exponentOf,
  fromMinor,
  portionBps,
  portionRatio,
  toMinor,
} from "../src/platform/money.ts";

test("toMinor parses decimal strings exactly", () => {
  assert.equal(toMinor("139.00", "USD"), 13900);
  assert.equal(toMinor("0.07", "USD"), 7);
  assert.equal(toMinor("19.9", "EUR"), 1990);
  assert.equal(toMinor("1500", "JPY"), 1500);
  assert.equal(toMinor("1500.00", "JPY"), 1500, "trailing zeros are harmless");
  assert.equal(toMinor("-4.50", "USD"), -450);
  assert.equal(toMinor("0.1", "USD") + toMinor("0.2", "USD"), 30, "no floating point drift");
});

test("toMinor refuses what it cannot represent", () => {
  assert.throws(() => toMinor("1.005", "USD"), /more decimal places/);
  assert.throws(() => toMinor("10.5", "JPY"), /more decimal places/);
  assert.throws(() => toMinor("12,50", "EUR"), /not a decimal amount/);
  assert.throws(() => toMinor("", "USD"), /not a decimal amount/);
  assert.throws(() => toMinor("1e3", "USD"), /not a decimal amount/);
});

test("fromMinor gives the string PayPal expects", () => {
  assert.equal(fromMinor(13900, "USD"), "139.00");
  assert.equal(fromMinor(7, "USD"), "0.07");
  assert.equal(fromMinor(1500, "JPY"), "1500");
  assert.equal(fromMinor(1500, "HUF"), "1500", "PayPal takes no decimals for HUF");
  assert.equal(fromMinor(1234, "KWD"), "1.234");
  assert.equal(fromMinor(-450, "USD"), "-4.50");
  assert.equal(exponentOf("TWD"), 0);
});

test("round trip is lossless for every exponent", () => {
  const cases: Array<[string, number[]]> = [
    ["USD", [0, 1, 99, 100, 123456789]],
    ["JPY", [0, 1, 500]],
    ["KWD", [0, 1, 999, 1000]],
  ];
  for (const [currency, samples] of cases) {
    for (const minor of samples) assert.equal(toMinor(fromMinor(minor, currency), currency), minor);
  }
});

test("rounding modes", () => {
  assert.equal(divideRounded(5n, 2n, "half_up"), 3n);
  assert.equal(divideRounded(5n, 2n, "half_even"), 2n);
  assert.equal(divideRounded(7n, 2n, "half_even"), 4n);
  assert.equal(divideRounded(5n, 2n, "down"), 2n);
  assert.equal(divideRounded(5n, 2n, "up"), 3n);
  assert.equal(divideRounded(4n, 2n, "up"), 2n, "exact division is never rounded");
  assert.equal(portionBps(999, 5000), 500, "4.995 rounds half up to 5.00");
  assert.equal(portionBps(999, 5000, "down"), 499);
  assert.equal(portionBps(13900, 2500), 3475);
  assert.equal(portionRatio(3000, 10, 31), 968, "10 of 31 days of 30.00");
});

test("allocate splits without losing or creating a cent", () => {
  assert.deepEqual(allocate(100, [1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(allocate(5, [0, 0]), [5, 0], "all-zero weights: everything to the first part");
  assert.deepEqual(allocate(0, [3, 7]), [0, 0]);
  assert.deepEqual(allocate(-100, [1, 1, 1]), [-34, -33, -33]);
  for (const total of [1, 7, 99, 100, 101, 12345]) {
    for (const weights of [[1], [1, 2], [3, 3, 3], [5, 0, 1], [999, 1], [1, 1, 1, 1, 1, 1, 1]]) {
      const parts = allocate(total, weights);
      assert.equal(parts.reduce((a, b) => a + b, 0), total, `sum for ${total} over ${weights}`);
      assert.ok(parts.every((p) => p >= 0));
    }
  }
});
