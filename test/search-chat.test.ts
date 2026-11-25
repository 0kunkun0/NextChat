import {
  countMatches,
  searchSessions,
  type ChatSearchResult,
} from "../app/utils/search-chat";
import type { ChatSession } from "../app/store/chat";

/**
 * 「搜索聊天记录」两个老问题：
 *   1. 一条会话里命中多处时只显示一处（只截了第一段前 70 字）；
 *   2. 点击结果不跳转（只切会话）。
 * 这里覆盖检索部分：每条命中都要带 messageId / 位置，界面才能逐条跳转。
 */
function session(
  id: string,
  topic: string,
  messages: Array<{ id: string; role: "user" | "assistant"; content: any }>,
): ChatSession {
  return {
    id,
    topic,
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      date: "",
    })),
    lastUpdate: 0,
  } as any;
}

describe("searchSessions", () => {
  test("一条会话里命中多处时全部返回，各带 messageId", () => {
    const results = searchSessions(
      [
        session("s1", "网络模块", [
          { id: "m1", role: "user", content: "setTimeout 怎么设置超时" },
          { id: "m2", role: "assistant", content: "用 setTimeout 设置" },
        ]),
      ],
      "timeout",
    );

    expect(results).toHaveLength(1);
    expect(results[0].matches).toHaveLength(2);
    expect(results[0].matches.map((m) => m.messageId)).toEqual(["m1", "m2"]);
  });

  test("数组形式的内容（图片/文件/文本块）也能搜到", () => {
    const results = searchSessions(
      [
        session("s1", "带附件的对话", [
          {
            id: "m1",
            role: "user",
            content: [
              { type: "text", text: "看这张图里的 Timeout 设置" },
              {
                type: "image_url",
                image_url: { url: "data:image/png;base64,x" },
              },
            ],
          },
        ]),
      ],
      "timeout",
    );

    expect(results[0].matches[0].messageId).toBe("m1");
  });

  test("忽略大小写，片段包含命中词前后文", () => {
    const results = searchSessions(
      [
        session("s1", "t", [
          { id: "m1", role: "user", content: "AAAA TIMEOUT BBBB" },
        ]),
      ],
      "timeout",
    );
    expect(results[0].matches[0].snippet.toLowerCase()).toContain("timeout");
  });

  test("同一段重复命中不重复列出", () => {
    const results = searchSessions(
      [session("s1", "t", [{ id: "m1", role: "user", content: "abcabcabc" }])],
      "abc",
      { contextChars: 2 },
    );
    // 三次命中落在同一片段窗口里 → 去重成一条
    expect(results[0].matches).toHaveLength(1);
  });

  test("每个会话最多保留 perSession 条", () => {
    const words = Array.from({ length: 10 }, (_, i) => `第${i}次 hit`).join(
      "，",
    );
    const results = searchSessions(
      [session("s1", "t", [{ id: "m1", role: "user", content: words }])],
      "hit",
      { perSession: 3 },
    );
    expect(results[0].matches).toHaveLength(3);
  });

  test("结果按命中数排序，命中多的在前", () => {
    const results = searchSessions(
      [
        session("s1", "少", [{ id: "m1", role: "user", content: "hit" }]),
        session("s2", "多", [
          { id: "m2", role: "user", content: "hit hit" },
          { id: "m3", role: "assistant", content: "hit" },
        ]),
      ],
      "hit",
    );
    expect(results.map((r) => r.sessionId)).toEqual(["s2", "s1"]);
  });

  test("空关键词返回空结果", () => {
    expect(searchSessions([session("s1", "t", [])], "   ")).toEqual([]);
  });

  test("countMatches 汇总所有会话的命中数", () => {
    const results: ChatSearchResult[] = [
      { sessionIndex: 0, sessionId: "a", topic: "A", matches: [{}, {}] as any },
      { sessionIndex: 1, sessionId: "b", topic: "B", matches: [{}] as any },
    ];
    expect(countMatches(results)).toBe(3);
  });
});
