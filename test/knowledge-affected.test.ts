import {
  findAffectedSessions,
  formatAffectedTopics,
  sectionBelongsToDoc,
  stripDocReferences,
} from "../app/utils/knowledge/affected";

/**
 * 删除知识库文档时的影响面分析。
 *
 * 片段 id 是 `<docId>-<序号>`，文档名里本身可能带 `-`（`ikun-README-md-ab12cd34-7`），
 * 所以归属判断用「前缀 + 纯数字后缀」，不能简单 split("-")。
 */
const DOC_A = "ikun-README-md-ab12cd34";
const DOC_B = "stl-README-md-ef56gh78";

function message(id: string, sectionIds: string[]) {
  return {
    id,
    retrieval:
      sectionIds.length > 0
        ? {
            sections: sectionIds.map((sid) => ({
              id: sid,
              headingPath: `概述 › ${sid}`,
              docName: "x.md",
              chars: 100,
            })),
            tokens: 50,
          }
        : undefined,
  };
}

describe("sectionBelongsToDoc", () => {
  test("前缀 + 序号 才算属于该文档", () => {
    expect(sectionBelongsToDoc(`${DOC_A}-0`, DOC_A)).toBe(true);
    expect(sectionBelongsToDoc(`${DOC_A}-123`, DOC_A)).toBe(true);
  });

  test("文档名里带 - 也能正确判断", () => {
    expect(
      sectionBelongsToDoc(
        "ikun-README-md-ab12cd34-7",
        "ikun-README-md-ab12cd34",
      ),
    ).toBe(true);
  });

  test("别的文档 / 非法 id 不算", () => {
    expect(sectionBelongsToDoc(`${DOC_B}-1`, DOC_A)).toBe(false);
    expect(sectionBelongsToDoc("", DOC_A)).toBe(false);
    expect(sectionBelongsToDoc(`${DOC_A}-x`, DOC_A)).toBe(false);
  });

  test("正则元字符不会误伤", () => {
    // docId 里正常不会出现 . 但保险起见验证转义
    expect(sectionBelongsToDoc("a.b-1", "a.b")).toBe(true);
    expect(sectionBelongsToDoc("axb-1", "a.b")).toBe(false);
  });
});

describe("findAffectedSessions", () => {
  const sessions = [
    {
      id: "s1",
      topic: "网络模块",
      messages: [message("m1", [`${DOC_A}-1`]), message("m2", [`${DOC_B}-2`])],
    },
    {
      id: "s2",
      topic: "无关对话",
      messages: [message("m3", [`${DOC_B}-1`])],
    },
    {
      id: "s3",
      topic: "手动勾选过",
      messages: [],
      knowledge: { sectionIds: [`${DOC_A}-3`] },
    },
  ];

  test("只找引用了该文档的会话", () => {
    const affected = findAffectedSessions(sessions as any, [DOC_A]);
    expect(affected.map((item) => item.session.id).sort()).toEqual([
      "s1",
      "s3",
    ]);
  });

  test("同时删除多个文档时合并统计", () => {
    const affected = findAffectedSessions(sessions as any, [DOC_A, DOC_B]);
    expect(affected.map((item) => item.session.id).sort()).toEqual([
      "s1",
      "s2",
      "s3",
    ]);
    // s1 里两条消息各引用一个文档
    expect(affected.find((item) => item.session.id === "s1")?.messages).toBe(2);
  });

  test("没有引用时返回空", () => {
    expect(findAffectedSessions(sessions as any, ["nope"])).toEqual([]);
  });
});

describe("stripDocReferences", () => {
  test("删掉对应片段，保留其它文档的引用", () => {
    const session = {
      id: "s1",
      messages: [
        message("m1", [`${DOC_A}-1`, `${DOC_B}-2`]),
        message("m2", [`${DOC_B}-1`]),
      ],
    };

    const result = stripDocReferences(session as any, [DOC_A]);

    expect(result.removedSections).toBe(1);
    expect(result.clearedMessages).toBe(0);
    expect(session.messages[0].retrieval?.sections.map((s) => s.id)).toEqual([
      `${DOC_B}-2`,
    ]);
    expect(session.messages[1].retrieval?.sections).toHaveLength(1);
  });

  test("整条消息只引用了被删文档时，retrieval 一起去掉", () => {
    const session = {
      id: "s2",
      messages: [message("m1", [`${DOC_A}-1`])],
    };

    const result = stripDocReferences(session as any, [DOC_A]);

    expect(result.clearedMessages).toBe(1);
    expect(session.messages[0].retrieval).toBeUndefined();
  });

  test("清掉会话里勾选的失效片段", () => {
    const session = {
      id: "s3",
      messages: [],
      knowledge: {
        enabled: true,
        sectionIds: [`${DOC_A}-1`, `${DOC_B}-1`],
      },
    };

    const result = stripDocReferences(session as any, [DOC_A]);

    expect(result.removedPinned).toBe(1);
    expect(session.knowledge.sectionIds).toEqual([`${DOC_B}-1`]);
    // 其它设置保持不变
    expect(session.knowledge.enabled).toBe(true);
  });

  test("没有任何引用时不产生改动", () => {
    const session = { id: "s4", messages: [message("m1", [])] };
    const result = stripDocReferences(session as any, [DOC_A]);
    expect(result).toEqual({
      removedSections: 0,
      clearedMessages: 0,
      removedPinned: 0,
    });
  });
});

describe("formatAffectedTopics", () => {
  test("超过上限时用“等 N 个对话”收尾", () => {
    const affected = Array.from({ length: 8 }, (_, i) => ({
      session: { id: `s${i}`, topic: `对话${i}` },
    }));
    expect(formatAffectedTopics(affected as any, 3)).toBe(
      "对话0、对话1、对话2 等 8 个对话",
    );
  });

  test("没标题的用占位名", () => {
    expect(formatAffectedTopics([{ session: { id: "s" } }] as any)).toBe(
      "(无标题)",
    );
  });
});
