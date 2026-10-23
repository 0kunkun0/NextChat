import { normalizeBlankLines } from "../app/utils/format";

describe("normalizeBlankLines", () => {
  test("keeps normal blank lines", () => {
    expect(normalizeBlankLines("a\n\nb")).toBe("a\n\nb");
    expect(normalizeBlankLines("第一段\n\n第二段")).toBe("第一段\n\n第二段");
  });

  test("turns whitespace-only lines into real blank lines", () => {
    // 全角空格 / NBSP / 普通空格 + tab，CommonMark 都不认为是空行
    expect(normalizeBlankLines("a\n\u3000\nb")).toBe("a\n\nb");
    expect(normalizeBlankLines("a\n\u00a0\nb")).toBe("a\n\nb");
    expect(normalizeBlankLines("a\n \t \nb")).toBe("a\n\nb");
    // 零宽空格
    expect(normalizeBlankLines("a\n\u200b\nb")).toBe("a\n\nb");
  });

  test("normalizes CRLF and CR", () => {
    expect(normalizeBlankLines("a\r\n\r\nb")).toBe("a\n\nb");
    expect(normalizeBlankLines("a\r\rb")).toBe("a\n\nb");
  });

  test("does not touch content inside code fences", () => {
    const code = "```\nconst a = 1;\n\u3000\nconst b = 2;\n```";
    expect(normalizeBlankLines(code)).toBe(code);
  });

  test("keeps non-blank lines completely unchanged", () => {
    const text = "  indented line\n\ttabbed\n\nend";
    expect(normalizeBlankLines(text)).toBe(text);
  });
});
