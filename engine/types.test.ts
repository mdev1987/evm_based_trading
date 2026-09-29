import { describe, expect, test } from "bun:test";

import { emptySnapshot, snapshotNumber, snapshotTimestamp } from "./types";

describe("entry snapshot helpers", () => {
  test("emptySnapshot is all nulls", () => {
    expect(Object.values(emptySnapshot()).every((value) => value === null)).toBe(true);
  });

  test("snapshotNumber keeps finite non-negative numbers", () => {
    expect(snapshotNumber(12.5)).toBe(12.5);
    expect(snapshotNumber(0)).toBe(0);
    expect(snapshotNumber(-1)).toBeNull();
    expect(snapshotNumber(Number.NaN)).toBeNull();
    expect(snapshotNumber("10")).toBeNull();
    expect(snapshotNumber(undefined)).toBeNull();
  });

  test("snapshotTimestamp normalizes seconds and ms", () => {
    expect(snapshotTimestamp(1720000000)).toBe(1720000000000);
    expect(snapshotTimestamp(1720000000000)).toBe(1720000000000);
    expect(snapshotTimestamp(0)).toBeNull();
    expect(snapshotTimestamp(-5)).toBeNull();
    expect(snapshotTimestamp("1720000000")).toBeNull();
  });
});
