import { chunkMarkdown } from "../app/utils/knowledge/chunker";
import {
  PINNED_BUDGET_TOKENS,
  pinnedHits,
  type KnowledgeChunk,
} from "../app/utils/knowledge/retrieval";

/**
 * 手动勾选很多片段时，不应该被默认的 40k 预算悄悄砍掉一半。
 * 用户勾了 96 节却只注入 50 节，看起来就是“选的和实际用的不一致”。
 */
function makeChunks(count: number, charsPerSection: number): KnowledgeChunk[] {
  const chunks: KnowledgeChunk[] = [];
  for (let i = 0; i < count; i++) {
    const body = "说明文字。".repeat(Math.ceil(charsPerSection / 5));
    const { sections } = chunkMarkdown(`## 小节 ${i}\n\n${body}`, {
      minChars: 0,
    });
    sections.forEach((section) => {
      chunks.push({
        ...section,
        id: `doc-${i}`,
        docId: "doc",
        docName: "ikun.md",
      });
    });
  }
  return chunks;
}

describe("pinnedHits 预算", () => {
  test("默认预算下 96 节里只装得下一部分（旧行为）", () => {
    const chunks = makeChunks(96, 2000); // 每节约 900 token
    const hits = pinnedHits(chunks, { budgetTokens: 40000 });
    expect(hits.length).toBeLessThan(chunks.length);
    expect(hits.length).toBeGreaterThan(0);
  });

  test("手动勾选的预算足够装下 96 节", () => {
    const chunks = makeChunks(96, 2000);
    const hits = pinnedHits(chunks, { budgetTokens: PINNED_BUDGET_TOKENS });
    expect(hits.length).toBe(96);
  });

  test("即使超出预算，也保留顺序且不重复", () => {
    const chunks = makeChunks(10, 2000);
    const hits = pinnedHits(chunks, { budgetTokens: 3000 });
    const ids = hits.map((hit) => hit.chunk.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(chunks.slice(0, ids.length).map((chunk) => chunk.id));
  });
});
