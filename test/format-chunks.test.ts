import { TextDecoder, TextEncoder } from "util";
import { chunks } from "../app/utils/format";

// jsdom 没有 TextEncoder/TextDecoder，分片逻辑依赖它们
if (typeof globalThis.TextEncoder === "undefined") {
  (globalThis as any).TextEncoder = TextEncoder;
}
if (typeof globalThis.TextDecoder === "undefined") {
  (globalThis as any).TextDecoder = TextDecoder;
}

const byteLength = (s: string) => new TextEncoder().encode(s).length;

describe("chunks", () => {
  test("yields the whole string in one piece when it fits", () => {
    expect([...chunks("helloworld", 1000)]).toEqual(["helloworld"]);
    expect([...chunks("hello world", 1000)]).toEqual(["hello world"]);
  });

  test("splits by bytes, not by spaces", () => {
    const result = [...chunks("hello world", 5)];
    expect(result).toEqual(["hello", " worl", "d"]);
    expect(result.every((c) => byteLength(c) <= 5)).toBe(true);
  });

  test("concatenating the pieces reproduces the original exactly", () => {
    const input = "the quick brown fox jumps over the lazy dog";
    const result = [...chunks(input, 8)];
    expect(result.every((c) => c.length > 0)).toBe(true);
    expect(result.join("")).toBe(input);
  });

  test("never splits in the middle of a multi-byte character", () => {
    const input = "😀😁😂🤣😃😄😅😆";
    const result = [...chunks(input, 6)];
    expect(result.join("")).toBe(input);
    expect(result.join("")).not.toContain("�");
    expect(result.every((c) => byteLength(c) <= 6)).toBe(true);
  });

  test("keeps every piece under the byte limit for large payloads", () => {
    const input = "x".repeat(2_500_000);
    const result = [...chunks(input, 1_000_000)];
    expect(result.length).toBe(3);
    expect(result.every((c) => byteLength(c) <= 1_000_000)).toBe(true);
    expect(result.join("")).toBe(input);
  });

  test("produces no chunks for an empty string", () => {
    expect([...chunks("")]).toEqual([]);
  });
});
