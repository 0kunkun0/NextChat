import { highlightParts, previewOf } from "../app/utils/knowledge/preview";
import type { KnowledgeChunk } from "../app/utils/knowledge/retrieval";

/**
 * 片段选择弹窗里的「关键字高亮 + 命中处预览」。
 *
 * 目的：搜到某一节时，能立刻看到关键字在正文的哪一段，而不是永远看开头。
 */
function chunk(text: string): KnowledgeChunk {
  return {
    id: "sec-1",
    docId: "doc",
    docName: "ikun.README.md",
    headingPath: "概述 › 网络",
    heading: "网络",
    level: 3,
    text,
    chars: text.length,
    codeChars: 0,
    codeBlocks: 0,
    estTokens: Math.round(text.length / 2.2),
    startLine: 1,
    endLine: 1,
  };
}

describe("highlightParts", () => {
  test("没有关键字时原样返回", () => {
    expect(highlightParts("设置超时的方法", "")).toEqual([
      { text: "设置超时的方法", hit: false },
    ]);
  });

  test("命中处切成三段（前 / 命中 / 后）", () => {
    const parts = highlightParts("先设置超时再看日志", "超时");
    expect(parts).toEqual([
      { text: "先设置", hit: false },
      { text: "超时", hit: true },
      { text: "再看日志", hit: false },
    ]);
  });

  test("多次出现都标出来", () => {
    const parts = highlightParts("超时 A 超时 B", "超时");
    expect(parts.filter((part) => part.hit).map((part) => part.text)).toEqual([
      "超时",
      "超时",
    ]);
  });

  test("忽略大小写", () => {
    const parts = highlightParts("SetTimeout vs settimeout", "SETTIMEOUT");
    expect(parts.filter((part) => part.hit)).toHaveLength(2);
  });

  test("正则元字符不会炸（用 indexOf 实现）", () => {
    const parts = highlightParts("调用 f(x) 和 a[0] 以及 b*c", "f(x)");
    expect(parts.some((part) => part.hit && part.text === "f(x)")).toBe(true);
    // 不该把整串都标红
    expect(parts).toHaveLength(3);
  });

  test("关键字不在文本里时不标记", () => {
    const parts = highlightParts("完全无关的内容", "超时");
    expect(parts).toEqual([{ text: "完全无关的内容", hit: false }]);
  });
});

describe("previewOf 命中处截取", () => {
  const longText = `# 网络\n\n${"前面的无关说明。".repeat(
    40,
  )}这里讲 SetTimeout 的用法。${"后面的内容。".repeat(40)}`;

  test("有关键字时从命中处开始截", () => {
    const preview = previewOf(chunk(longText), "SetTimeout");
    expect(preview).toContain("SetTimeout");
    expect(preview.startsWith("…")).toBe(true);
  });

  test("关键字位置靠前时也带上命中后的上下文", () => {
    // 查询用小写，正文是 SetTimeout：命中不区分大小写，但预览保留原文大小写
    const preview = previewOf(chunk(longText), "settimeout");
    expect(preview).toContain("SetTimeout");
    expect(preview.length).toBeLessThanOrEqual(140);
  });

  test("关键字不在正文里时退回开头预览", () => {
    const preview = previewOf(chunk(longText), "完全不存在");
    expect(preview.startsWith("…")).toBe(false);
    expect(preview).toContain("前面的无关说明");
  });

  test("没有关键字时和以前一致（120 字 + 省略号）", () => {
    const preview = previewOf(chunk(longText));
    expect(preview.endsWith("…")).toBe(true);
    expect(preview.length).toBeLessThanOrEqual(121);
  });
});
