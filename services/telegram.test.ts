import { describe, expect, test } from "bun:test";
import { splitMessage } from "./telegram";

describe("Telegram message splitting", () => {
  test("keeps short messages intact", () => {
    expect(splitMessage("hello world")).toEqual(["hello world"]);
  });

  test("splits oversized messages", () => {
    const parts = splitMessage("a".repeat(8000));
    expect(parts.length).toBe(3);
    expect(parts.every((part) => part.length <= 3900)).toBe(true);
  });

  test("does not leave an odd escape at a chunk boundary", () => {
    const text = "a".repeat(3899) + "\\!" + "b".repeat(100);
    const parts = splitMessage(text);
    expect(parts.every((part) => !/\\+$/.test(part))).toBe(true);
  });
});
