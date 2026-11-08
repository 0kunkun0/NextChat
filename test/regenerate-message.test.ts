import { useChatStore } from "../app/store/chat";

function makeSession() {
  return {
    id: "s1",
    topic: "t",
    messages: [
      { id: "u1", role: "user", content: "1+1 等于几", date: "" },
      {
        id: "a1",
        role: "assistant",
        content: "1+1 等于 2。",
        date: "",
        model: "deepseek-chat",
      },
    ],
    mask: { modelConfig: { model: "deepseek-chat", providerName: "DeepSeek" } },
    stat: { tokenCount: 0, wordCount: 0, charCount: 0 },
    lastUpdate: 1,
    lastSummarizeIndex: 0,
    memoryPrompt: "",
  } as any;
}

describe("regenerateMessage", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // 不真的发请求：只关心状态机
    (globalThis as any).fetch = () =>
      Promise.reject(new Error("network disabled in test"));
  });

  afterEach(() => {
    (globalThis as any).fetch = originalFetch;
  });

  test("clears the old reply immediately, before the history is ready", async () => {
    const session = makeSession();
    useChatStore.setState({
      sessions: [session],
      currentSessionIndex: 0,
    } as any);

    // 让历史拼装挂住：模拟 MCP / 记忆摘要很慢的情况
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    useChatStore.setState({
      getMessagesWithMemory: () => gate.then(() => [] as any),
    } as any);

    const pending = useChatStore
      .getState()
      .regenerateMessage(session, "a1")
      .catch(() => {});

    // 还没等历史返回，界面上的旧内容就该被清掉、并进入“生成中”
    expect(session.messages[1].content).toBe("");
    expect(session.messages[1].streaming).toBe(true);

    release();
    await pending;
  });

  test("a second click while regenerating does not start another reply", async () => {
    const session = makeSession();
    useChatStore.setState({
      sessions: [session],
      currentSessionIndex: 0,
    } as any);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    useChatStore.setState({
      getMessagesWithMemory: () => gate.then(() => [] as any),
    } as any);

    const first = useChatStore
      .getState()
      .regenerateMessage(session, "a1")
      .catch(() => {});

    // 第一次点击后已经是 streaming，第二次点击应直接被忽略
    await useChatStore
      .getState()
      .regenerateMessage(session, "a1")
      .catch(() => {});

    // 原回复 + 新候选，共 2 条；如果没挡住会变成 3 条
    expect(session.messages[1].variants?.length).toBe(2);

    release();
    await first;
  });
});
