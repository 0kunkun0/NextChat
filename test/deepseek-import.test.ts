import { strToU8, zipSync } from "fflate";

import {
  parseDeepseekExport,
  selectBranch,
  toChatSession,
  type DeepseekConversationFile,
} from "../app/utils/deepseek-import";

/**
 * DeepSeek 官网导出的结构（export_format_version = 3）：
 *   manifest.json / chat_session_index.json / chat_sessions/{id}.json
 * 这里用 fflate 现场造一个合成压缩包来验证解析与映射。
 */
function makeZip(entries: Record<string, any>) {
  const files: Record<string, Uint8Array> = {};
  for (const [name, value] of Object.entries(entries)) {
    files[name] =
      typeof value === "string"
        ? strToU8(value)
        : strToU8(JSON.stringify(value));
  }
  return zipSync(files);
}

// 测试夹具用宽松类型：字面量里的 role 会被拓宽成 string
function conversation(overrides: any = {}): any {
  return {
    id: "conv-1",
    title: "测试会话",
    current_message_id: 2,
    inserted_at: "2026-11-01T10:00:00.000Z",
    messages: [
      {
        id: 1,
        parent_id: null,
        role: "USER",
        status: "FINISHED",
        inserted_at: "2026-11-01T10:00:00.000Z",
        fragments: [{ type: "REQUEST", content: "第一个问题" }],
      },
      {
        id: 2,
        parent_id: 1,
        role: "ASSISTANT",
        status: "FINISHED",
        inserted_at: "2026-11-01T10:00:05.000Z",
        fragments: [
          { type: "THINK", content: "先想一想", elapsed_secs: 2 },
          { type: "RESPONSE", content: "第一个回答" },
        ],
      },
    ],
    ...overrides,
  };
}

function exportOf(conversations: any[], version = 3) {
  const files: Record<string, any> = {
    "manifest.json": { export_format_version: version },
    "chat_session_index.json": conversations.map((item) => ({
      id: item.id,
      inserted_at: item.inserted_at,
      updated_at: item.inserted_at,
    })),
  };
  for (const item of conversations) {
    files[`chat_sessions/${item.id}.json`] = item;
  }
  return makeZip(files);
}

describe("parseDeepseekExport", () => {
  test("解析一个最简单的导出，映射成 user/assistant 两条消息", () => {
    const result = parseDeepseekExport(exportOf([conversation()]));

    expect(result.imported).toHaveLength(1);
    const { session, title } = result.imported[0];
    expect(title).toBe("测试会话");
    expect(session.topic).toBe("测试会话");
    expect(session.messages).toHaveLength(2);
    expect(session.messages[0].role).toBe("user");
    expect(session.messages[0].content).toBe("第一个问题");
    expect(session.messages[1].role).toBe("assistant");
    // 思考内容以引用块形式保留，正文跟在后面
    expect(session.messages[1].content).toContain("> 先想一想");
    expect(session.messages[1].content).toContain("第一个回答");
  });

  test("不支持 v3 以外的版本", () => {
    expect(() => parseDeepseekExport(exportOf([conversation()], 2))).toThrow(
      "unsupported-version",
    );
  });

  test("缺少索引 / manifest 时给出明确的错误", () => {
    expect(() =>
      parseDeepseekExport(
        zipSync({
          "manifest.json": strToU8(
            JSON.stringify({ export_format_version: 3 }),
          ),
        }),
      ),
    ).toThrow("missing-index");

    // 压缩包能读，但没有 manifest.json
    expect(() =>
      parseDeepseekExport(zipSync({ "chat_sessions/x.json": strToU8("{}") })),
    ).toThrow("missing-manifest");
  });

  test("索引里有、但缺少会话文件的条目会被跳过", () => {
    const zip = zipSync({
      "manifest.json": strToU8(JSON.stringify({ export_format_version: 3 })),
      "chat_session_index.json": strToU8(JSON.stringify([{ id: "ghost" }])),
    });

    const result = parseDeepseekExport(zip);
    expect(result.imported).toHaveLength(0);
    expect(result.skipped[0].id).toBe("ghost");
  });

  test("同一文件里多个会话按索引顺序导入", () => {
    const result = parseDeepseekExport(
      exportOf([
        conversation(),
        conversation({
          id: "conv-2",
          title: "第二个会话",
          messages: [
            {
              id: 1,
              parent_id: null,
              role: "USER",
              status: "FINISHED",
              inserted_at: "2026-11-02T10:00:00.000Z",
              fragments: [{ type: "REQUEST", content: "另一句" }],
            },
          ],
        }),
      ]),
    );

    expect(result.imported.map((item) => item.title)).toEqual([
      "测试会话",
      "第二个会话",
    ]);
  });
});

describe("selectBranch", () => {
  test("按 current_message_id 选择分支", () => {
    const file = conversation({
      current_message_id: 2,
      messages: [
        {
          id: 1,
          parent_id: null,
          role: "USER",
          status: "FINISHED",
          inserted_at: "2026-11-01T10:00:00.000Z",
          fragments: [{ type: "REQUEST", content: "问题" }],
        },
        {
          id: 2,
          parent_id: 1,
          role: "ASSISTANT",
          status: "FINISHED",
          inserted_at: "2026-11-01T10:00:01.000Z",
          fragments: [{ type: "RESPONSE", content: "老分支" }],
        },
        {
          id: 3,
          parent_id: 1,
          role: "ASSISTANT",
          status: "FINISHED",
          inserted_at: "2026-11-01T10:00:02.000Z",
          fragments: [{ type: "RESPONSE", content: "新分支" }],
        },
      ],
    });

    const chain = selectBranch(file);
    expect(chain.map((message) => message.id)).toEqual([1, 2]);
  });

  test("current_message_id 缺失时取 id 最大的叶子", () => {
    const file: any = conversation();
    delete file.current_message_id;
    file.messages.push({
      id: 3,
      parent_id: 1,
      role: "ASSISTANT",
      status: "FINISHED",
      inserted_at: "2026-11-01T10:00:02.000Z",
      fragments: [{ type: "RESPONSE", content: "新分支" }],
    });

    expect(selectBranch(file).map((message) => message.id)).toEqual([1, 3]);
  });
});

describe("toChatSession 的映射规则", () => {
  test("被内容过滤撤回的整轮跳过", () => {
    const session = toChatSession(
      conversation({
        current_message_id: 4,
        messages: [
          {
            id: 1,
            parent_id: null,
            role: "USER",
            status: "FINISHED",
            inserted_at: "2026-11-01T10:00:00.000Z",
            fragments: [{ type: "REQUEST", content: "被撤回的问题" }],
          },
          {
            id: 2,
            parent_id: 1,
            role: "ASSISTANT",
            status: "CONTENT_FILTER",
            inserted_at: "2026-11-01T10:00:01.000Z",
            fragments: [],
          },
          {
            id: 3,
            parent_id: 2,
            role: "USER",
            status: "FINISHED",
            inserted_at: "2026-11-01T10:00:02.000Z",
            fragments: [{ type: "REQUEST", content: "正常问题" }],
          },
          {
            id: 4,
            parent_id: 3,
            role: "ASSISTANT",
            status: "FINISHED",
            inserted_at: "2026-11-01T10:00:03.000Z",
            fragments: [{ type: "RESPONSE", content: "正常回答" }],
          },
        ],
      }),
      "标题",
    );

    expect(session.messages.map((message) => message.content)).toEqual([
      "正常问题",
      "正常回答",
    ]);
    expect(
      session.messages.some((message) =>
        String(message.content).includes("被撤回"),
      ),
    ).toBe(false);
  });

  test("未完成的回复标记成 isError（不进模型上下文）", () => {
    const session = toChatSession(
      conversation({
        messages: [
          {
            id: 1,
            parent_id: null,
            role: "USER",
            status: "FINISHED",
            inserted_at: "2026-11-01T10:00:00.000Z",
            fragments: [{ type: "REQUEST", content: "问题" }],
          },
          {
            id: 2,
            parent_id: 1,
            role: "ASSISTANT",
            status: "FAILED",
            inserted_at: "2026-11-01T10:00:01.000Z",
            fragments: [{ type: "RESPONSE", content: "半截回答" }],
          },
        ],
      }),
      "标题",
    );

    expect(session.messages[1].isError).toBe(true);
    expect(session.messages[1].content).toContain("FAILED");
  });

  test("联网搜索与打开网页写成链接行", () => {
    const session = toChatSession(
      conversation({
        messages: [
          {
            id: 1,
            parent_id: null,
            role: "USER",
            status: "FINISHED",
            inserted_at: "2026-11-01T10:00:00.000Z",
            fragments: [{ type: "REQUEST", content: "查一下" }],
          },
          {
            id: 2,
            parent_id: 1,
            role: "ASSISTANT",
            status: "FINISHED",
            inserted_at: "2026-11-01T10:00:01.000Z",
            fragments: [
              {
                type: "TOOL_SEARCH",
                queries: ["天气"],
                results: [{ url: "https://example.com/a", title: "示例" }],
              },
              {
                type: "TOOL_OPEN",
                status: "FINISHED",
                url: "https://example.com/b",
                title: "网页",
              },
              { type: "RESPONSE", content: "查到了" },
            ],
          },
        ],
      }),
      "标题",
    );

    const answer = session.messages[1].content;
    expect(answer).toContain("联网搜索：天气");
    expect(answer).toContain("[示例](https://example.com/a)");
    expect(answer).toContain("[网页](https://example.com/b)");
    expect(answer).toContain("查到了");
  });

  test("附件列成清单，不假装有内容", () => {
    const session = toChatSession(
      conversation({
        messages: [
          {
            id: 1,
            parent_id: null,
            role: "USER",
            status: "FINISHED",
            inserted_at: "2026-11-01T10:00:00.000Z",
            fragments: [
              { type: "REQUEST", content: "看这个文件" },
              {
                type: "FILE",
                files: [
                  {
                    id: "f1",
                    file_name: "报告.pdf",
                    file_size: 2048,
                    is_image: false,
                    export_path: null,
                  },
                ],
              },
            ],
          },
        ],
      }),
      "标题",
    );

    const content = String(session.messages[0].content);
    expect(content).toContain("看这个文件");
    expect(content).toContain("报告.pdf");
    expect(content).toContain("2.0 KB");
  });

  test("没有任何可导入问答的会话直接报错", () => {
    expect(() => toChatSession(conversation({ messages: [] }), "标题")).toThrow(
      "conversation has no messages",
    );
  });
});
