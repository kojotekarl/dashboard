import { describe, expect, test } from "bun:test";
import {
  assertValidRank,
  compareRanks,
  generateBetween,
  generateInitial,
} from "../server/repo/rank.ts";

describe("rank.generateBetween", () => {
  test("between null and null returns the alphabet midpoint", () => {
    // floor((96 + 123) / 2) = 109 = 'm'
    expect(generateBetween(null, null)).toBe("m");
  });

  test("midpoint of 'a' and 'c' is 'b'", () => {
    expect(generateBetween("b", "d")).toBe("c");
  });

  test("between null left and 'n' returns something < 'n'", () => {
    const r = generateBetween(null, "n");
    expect(compareRanks(r, "n")).toBe(-1);
  });

  test("between 'n' and null returns something > 'n'", () => {
    const r = generateBetween("n", null);
    expect(compareRanks(r, "n")).toBe(1);
  });

  test("between 'b' and 'c' extends to a deeper rank", () => {
    const r = generateBetween("b", "c");
    expect(compareRanks(r, "b")).toBe(1);
    expect(compareRanks(r, "c")).toBe(-1);
  });

  test("repeated bisection always produces a strictly between rank", () => {
    let left = "b";
    let right = "y";
    for (let i = 0; i < 20; i++) {
      const mid = generateBetween(left, right);
      expect(compareRanks(left, mid)).toBe(-1);
      expect(compareRanks(mid, right)).toBe(-1);
      // Alternate which side we re-bisect
      if (i % 2 === 0) right = mid;
      else left = mid;
    }
  });

  test("throws on left >= right", () => {
    expect(() => generateBetween("d", "b")).toThrow();
    expect(() => generateBetween("c", "c")).toThrow();
  });

  test("rejects invalid input ranks", () => {
    expect(() => generateBetween("A", "b")).toThrow();
    expect(() => generateBetween("ba", "c")).toThrow(); // trailing 'a' invalid
    expect(() => generateBetween("", "b")).toThrow();
    expect(() => assertValidRank("za")).toThrow();
  });
});

describe("rank.generateInitial", () => {
  test("returns N evenly-spaced ranks in order", () => {
    const r = generateInitial(5);
    expect(r).toEqual(["b", "c", "d", "e", "f"]);
    for (let i = 1; i < r.length; i++) {
      expect(compareRanks(r[i - 1]!, r[i]!)).toBe(-1);
    }
  });

  test("empty for count 0, throws above 24", () => {
    expect(generateInitial(0)).toEqual([]);
    expect(() => generateInitial(25)).toThrow();
  });
});
