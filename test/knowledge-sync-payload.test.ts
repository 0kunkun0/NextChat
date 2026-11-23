import { normalizeKnowledgePayload } from "../app/utils/knowledge/payload";

/**
 * 云端知识库 payload 的两种形态：
 *   - `upstash.download()` 读 store 时已经 JSON.parse 过 → **对象**
 *   - 直接读原始 key / 老数据 → **字符串**
 *
 * 之前 importKnowledgeJson 只接受字符串，`remote["__knowledge__"]` 是对象时
 * 直接 return，"下载后知识库还是空的"。这里把两种形态都钉死。
 */
const valid = {
  version: 1 as const,
  exportedAt: 123,
  docs: [{ id: "doc-1", name: "ikun.md", hash: "abc", chars: 10, chunks: 1 }],
  chunks: [{ id: "doc-1-0", docId: "doc-1", docName: "ikun.md", text: "超时" }],
};

describe("normalizeKnowledgePayload", () => {
  test("接受已经解析好的对象（下载回来的形态）", () => {
    expect(normalizeKnowledgePayload(valid)).toMatchObject({
      version: 1,
      docs: valid.docs,
      chunks: valid.chunks,
    });
  });

  test("接受 JSON 字符串（原始 key / 老数据）", () => {
    const result = normalizeKnowledgePayload(JSON.stringify(valid));
    expect(result?.docs).toEqual(valid.docs);
    expect(result?.chunks).toEqual(valid.chunks);
  });

  test("空知识库也合法（清空要能同步出去）", () => {
    const result = normalizeKnowledgePayload({
      version: 1,
      exportedAt: 1,
      docs: [],
      chunks: [],
    });
    expect(result?.docs).toEqual([]);
    expect(result?.chunks).toEqual([]);
  });

  test("缺 chunks 时补成空数组", () => {
    const result = normalizeKnowledgePayload({
      version: 1,
      docs: valid.docs,
    });
    expect(result?.chunks).toEqual([]);
  });

  test("无效输入返回 null", () => {
    expect(normalizeKnowledgePayload(null)).toBeNull();
    expect(normalizeKnowledgePayload(undefined)).toBeNull();
    expect(normalizeKnowledgePayload("not json")).toBeNull();
    expect(normalizeKnowledgePayload({ version: 2, docs: [] })).toBeNull();
    expect(normalizeKnowledgePayload({ version: 1 })).toBeNull();
    expect(normalizeKnowledgePayload(42)).toBeNull();
  });

  test("exportedAt 缺失时补当前时间（不抛错）", () => {
    const result = normalizeKnowledgePayload({ version: 1, docs: [] });
    expect(typeof result?.exportedAt).toBe("number");
    expect(result!.exportedAt).toBeGreaterThan(0);
  });
});
