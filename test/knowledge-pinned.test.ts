import { chunkMarkdown } from "../app/utils/knowledge/chunker";
import {
  formatInjection,
  pinnedHits,
  type KnowledgeChunk,
} from "../app/utils/knowledge/retrieval";
import { previewOf } from "../app/utils/knowledge/preview";

/**
 * 手动勾选知识库片段（会话设置里的「选择片段」）。
 *
 * 场景：文档标题都是「# 概述」这类泛化词，自动检索挑不准，
 * 用户直接点名要哪几节，发送时原样注入。
 */
function makeChunks(): KnowledgeChunk[] {
  const doc = `
# 概述

这是关于网络模块的总体说明。

## 设置超时

SetTimeout 用于设置连接超时，单位毫秒。

## 日志

ikun.debug 提供日志输出。
`.trim();

  const { sections } = chunkMarkdown(doc, { minChars: 0 });
  return sections.map((section, index) => ({
    ...section,
    id: `doc-${index}`,
    docId: "doc",
    docName: "ikun.README.md",
  }));
}

describe("pinnedHits", () => {
  test("按给定顺序原样注入，不做检索过滤", () => {
    const chunks = makeChunks();
    const picked = [chunks[2], chunks[1]];
    const hits = pinnedHits(picked);
    expect(hits.map((hit) => hit.chunk.heading)).toEqual(["日志", "设置超时"]);
    expect(hits.every((hit) => hit.score === 0)).toBe(true);
  });

  test("超预算时截断，但至少保留一节", () => {
    // 约 6000 字的一节（≈2700 token），预算给 1：应该被截断而不是整段丢弃
    const long = "说明文字内容。".repeat(700);
    const chunks: KnowledgeChunk[] = [
      {
        ...makeChunks()[0],
        text: `## 长节\n\n${long}`,
        chars: long.length,
        estTokens: 2700,
      },
      makeChunks()[1],
    ];

    const hits = pinnedHits(chunks, { budgetTokens: 1 });
    expect(hits.length).toBe(1);
    expect(hits[0].truncated).toBe(true);
  });

  test("注入文本里带来源文件名", () => {
    const hits = pinnedHits(makeChunks().slice(1, 2));
    const text = formatInjection(hits);
    expect(text).toContain("来源：ikun.README.md");
    expect(text).toContain("### [1]");
  });
});

describe("previewOf（选择弹窗里的正文预览）", () => {
  test("去掉标题行、压缩空白，超长加省略号", () => {
    const [first] = makeChunks();
    const preview = previewOf(first);
    expect(preview.startsWith("这是关于网络模块")).toBe(true);
    expect(preview).not.toContain("# 概述");
  });

  test("正文很长时截断到 120 字以内", () => {
    const long = "说明文字。".repeat(100);
    const chunks: KnowledgeChunk[] = [
      {
        ...makeChunks()[0],
        text: `# 概述\n\n${long}`,
        chars: long.length,
      },
    ];
    const preview = previewOf(chunks[0]);
    expect(preview.length).toBeLessThanOrEqual(121);
    expect(preview.endsWith("…")).toBe(true);
  });

  test("只有标题没有正文时也能给出预览", () => {
    const chunks: KnowledgeChunk[] = [{ ...makeChunks()[0], text: "# 空节" }];
    expect(previewOf(chunks[0])).toBe("# 空节");
  });
});
