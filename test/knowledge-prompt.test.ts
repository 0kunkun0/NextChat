import {
  lastUserText,
  pickKnowledgeSectionIds,
  resolveKnowledgeTarget,
} from "../app/utils/knowledge/prompt";

/**
 * 「本轮注入哪几节知识库」的优先级。
 *
 * 之前的 bug：只认消息上记录的旧 id，所以在会话设置里改完勾选、
 * 再点重新生成，用的还是旧引用（界面数字也不变）。
 */
const userMessage = (ids: string[], text = "怎么设置超时") => ({
  role: "user",
  content: text,
  retrieval: { sections: ids.map((id) => ({ id })), tokens: 100 },
});

describe("resolveKnowledgeTarget", () => {
  test("手动勾选了片段 → 优先用它（重新生成也会跟着变）", () => {
    const target = resolveKnowledgeTarget({
      pinned: ["new-1", "new-2"],
      messages: [userMessage(["old-1"])],
    });
    expect(target).toEqual({ mode: "pinned", ids: ["new-1", "new-2"] });
  });

  test("明确清空勾选 → 按这条用户消息重新检索", () => {
    const target = resolveKnowledgeTarget({
      pinned: [],
      messages: [userMessage(["old-1"], "ikun.net 怎么用")],
    });
    expect(target).toEqual({ mode: "auto", text: "ikun.net 怎么用" });
  });

  test("从没配置过 → 沿用消息里记录的 id", () => {
    const target = resolveKnowledgeTarget({
      pinned: undefined,
      messages: [userMessage(["old-1", "old-2"])],
    });
    expect(target).toEqual({ mode: "stored", ids: ["old-1", "old-2"] });
  });

  test("清空勾选但消息没有文本 → none", () => {
    const target = resolveKnowledgeTarget({
      pinned: [],
      messages: [{ role: "user", content: "" }],
    });
    expect(target).toEqual({ mode: "none" });
  });

  test("没有任何引用信息 → none", () => {
    expect(
      resolveKnowledgeTarget({
        pinned: undefined,
        messages: [{ role: "user", content: "hi" }],
      }),
    ).toEqual({ mode: "none" });
  });

  test("只看最近一条带引用的用户消息（重新生成时窗口被截断）", () => {
    const target = resolveKnowledgeTarget({
      pinned: undefined,
      messages: [
        userMessage(["old-1"]),
        { role: "assistant", content: "回答" },
        userMessage(["old-2"]),
      ],
    });
    expect(target).toEqual({ mode: "stored", ids: ["old-2"] });
  });
});

describe("lastUserText", () => {
  test("从多模态内容里取文本块", () => {
    expect(
      lastUserText([
        {
          role: "user",
          content: [
            { type: "text", text: "图片里是什么" },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,x" },
            },
          ],
        },
      ]),
    ).toBe("图片里是什么");
  });

  test("只有图片没有文本时返回空串", () => {
    expect(
      lastUserText([
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "x" } }],
        },
      ]),
    ).toBe("");
  });
});

describe("pickKnowledgeSectionIds", () => {
  test("跳过没有 id 的老记录", () => {
    expect(
      pickKnowledgeSectionIds([
        { role: "user", retrieval: { sections: [{ id: undefined }] } },
      ]),
    ).toEqual([]);
  });
});
