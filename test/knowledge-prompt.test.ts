import { pickKnowledgeSectionIds } from "../app/utils/knowledge/prompt";

/**
 * 「本轮注入哪几节知识库」的选取。
 *
 * 知识库资料现在作为 **system** 消息发送（不再拼进用户气泡），
 * 所以要先确定：这批 id 是从哪条消息上取的。
 */
describe("pickKnowledgeSectionIds", () => {
  test("取最近一条带引用的用户消息", () => {
    const ids = pickKnowledgeSectionIds([
      { role: "user", retrieval: { sections: [{ id: "old-1" }] } },
      { role: "assistant" },
      { role: "user", retrieval: { sections: [{ id: "a" }, { id: "b" }] } },
    ]);
    expect(ids).toEqual(["a", "b"]);
  });

  test("忽略没有引用的用户消息（往上找）", () => {
    const ids = pickKnowledgeSectionIds([
      { role: "user", retrieval: { sections: [{ id: "a" }] } },
      { role: "assistant" },
      { role: "user", retrieval: { sections: [] } },
    ]);
    expect(ids).toEqual(["a"]);
  });

  test("没有 id 时返回空（老消息只有标题元信息）", () => {
    const ids = pickKnowledgeSectionIds([
      { role: "user", retrieval: { sections: [{ id: undefined }] } },
    ]);
    expect(ids).toEqual([]);
  });

  test("完全没有引用时返回空数组", () => {
    expect(
      pickKnowledgeSectionIds([{ role: "user" }, { role: "assistant" }]),
    ).toEqual([]);
  });

  test("跳过 assistant 消息上的引用（理论上不该有）", () => {
    const ids = pickKnowledgeSectionIds([
      { role: "assistant", retrieval: { sections: [{ id: "ghost" }] } },
      { role: "user", retrieval: { sections: [{ id: "real" }] } },
    ]);
    expect(ids).toEqual(["real"]);
  });
});

describe("知识库作为 system 消息（结构约束）", () => {
  test("注入文本不进用户消息正文：id 与正文分离存放", () => {
    // 这里验证选 id 的逻辑不会顺手带上正文——
    // 正文由 store 在发请求时按 id 现取，避免气泡里出现几十万字符
    const message = {
      role: "user",
      retrieval: {
        sections: [
          { id: "sec-1", headingPath: "概述 › 设置超时", chars: 1200 },
        ],
        tokens: 400,
      },
    };
    const ids = pickKnowledgeSectionIds([message]);
    expect(ids).toEqual(["sec-1"]);
    expect(JSON.stringify(message.retrieval)).not.toContain("SetTimeout");
  });
});
