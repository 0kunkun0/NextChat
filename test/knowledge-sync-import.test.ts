import { jest } from "@jest/globals";

/**
 * 云端知识库的导入（settings 里的 applyRemoteKnowledge 走的就是这条路径）。
 *
 * 关键点：`upstash.download()` 读 store 时会先 JSON.parse，
 * 所以 `remote["__knowledge__"]` 是**对象**。早期实现只接受字符串，
 * 于是「下载后知识库还是空的」。
 *
 * 这里通过注入 writer 来测，避免真的去碰 IndexedDB。
 */
import { importKnowledgeJson } from "../app/utils/knowledge/sync";

const payload = {
  version: 1,
  exportedAt: 111,
  docs: [{ id: "doc-1", name: "ikun.md", hash: "h", chars: 10, chunks: 1 }],
  chunks: [{ id: "doc-1-0", docId: "doc-1", docName: "ikun.md", text: "超时" }],
};

describe("importKnowledgeJson", () => {
  test("接受对象形态（下载回来的就是对象）", async () => {
    const write = jest.fn(async () => {});
    const result = await importKnowledgeJson(payload, write);

    expect(result).toEqual({ docs: 1, chunks: 1 });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith({
      docs: payload.docs,
      chunks: payload.chunks,
    });
  });

  test("接受字符串形态（原始 key / 老数据）", async () => {
    const write = jest.fn(async () => {});
    const result = await importKnowledgeJson(JSON.stringify(payload), write);

    expect(result).toEqual({ docs: 1, chunks: 1 });
    expect(write).toHaveBeenCalledTimes(1);
  });

  test("空知识库也覆盖本地（清空要能同步过来）", async () => {
    const write = jest.fn(async () => {});
    const result = await importKnowledgeJson(
      { version: 1, exportedAt: 1, docs: [], chunks: [] },
      write,
    );

    expect(result).toEqual({ docs: 0, chunks: 0 });
    expect(write).toHaveBeenCalledWith({ docs: [], chunks: [] });
  });

  test("结构不对时不覆盖本地数据", async () => {
    const write = jest.fn(async () => {});
    const result = await importKnowledgeJson({ version: 99 }, write);

    expect(result).toEqual({ docs: 0, chunks: 0 });
    expect(write).not.toHaveBeenCalled();
  });
});
