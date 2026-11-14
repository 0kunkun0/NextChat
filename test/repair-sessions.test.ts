import { useChatStore } from "../app/store/chat";

function makeSession(overrides: any = {}) {
  return {
    id: "s1",
    topic: "标题",
    mask: { context: [] },
    stat: { tokenCount: 0, wordCount: 0, charCount: 0 },
    lastUpdate: 1,
    lastSummarizeIndex: 0,
    memoryPrompt: "",
    messages: [],
    ...overrides,
  } as any;
}

describe("repairLocalSessions", () => {
  test("fixes duplicate session ids without touching content or titles", () => {
    const a = makeSession({
      id: "dup",
      messages: [{ id: "m1", role: "user", content: "hello", date: "" }],
    });
    const b = makeSession({
      id: "dup",
      topic: "另一个标题",
      messages: [{ id: "m1", role: "user", content: "world", date: "" }],
    });
    useChatStore.setState({ sessions: [a, b], currentSessionIndex: 0 } as any);

    const report = useChatStore.getState().repairLocalSessions();
    const sessions = useChatStore.getState().sessions;

    expect(report.duplicateIds).toBe(1);
    // id 不再重复
    expect(new Set(sessions.map((s) => s.id)).size).toBe(2);
    // 内容和标题都保留
    expect(sessions[0].topic).toBe("标题");
    expect(sessions[1].topic).toBe("另一个标题");
    expect(sessions[0].messages[0].content).toBe("hello");
    expect(sessions[1].messages[0].content).toBe("world");
  });

  test("drops a redundant variant that is identical to the message content", () => {
    const session = makeSession({
      messages: [
        {
          id: "m1",
          role: "assistant",
          content: "answer",
          date: "",
          model: "m",
          variants: [{ content: "answer", model: "m", date: "" }],
          variantIndex: 0,
        },
      ],
    });
    useChatStore.setState({
      sessions: [session],
      currentSessionIndex: 0,
    } as any);

    const report = useChatStore.getState().repairLocalSessions();
    const message = useChatStore.getState().sessions[0].messages[0];

    expect(report.duplicateVariants).toBe(1);
    expect(message.variants).toBeUndefined();
    expect(message.content).toBe("answer");
  });

  test("dedupes completely identical variants but keeps real ones", () => {
    const session = makeSession({
      messages: [
        {
          id: "m1",
          role: "assistant",
          content: "v2",
          date: "",
          model: "m",
          variants: [
            { content: "v1", model: "m", date: "" },
            { content: "v2", model: "m", date: "" },
            { content: "v2", model: "m", date: "" },
          ],
          variantIndex: 2,
        },
      ],
    });
    useChatStore.setState({
      sessions: [session],
      currentSessionIndex: 0,
    } as any);

    const report = useChatStore.getState().repairLocalSessions();
    const message = useChatStore.getState().sessions[0].messages[0];

    expect(report.duplicateVariants).toBe(1);
    expect(message.variants).toHaveLength(2);
    // 索引被夹回合法范围
    expect(message.variantIndex).toBe(1);
  });
});
