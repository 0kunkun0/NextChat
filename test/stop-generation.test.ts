import { useChatStore } from "../app/store/chat";
import { ChatControllerPool } from "../app/client/controller";

function makeSession(withContext: boolean) {
  return {
    id: "s1",
    topic: "t",
    messages: [],
    mask: {
      modelConfig: { model: "deepseek-chat", providerName: "DeepSeek" },
      // 历史组装会读它；不给的话会立刻抛错（这条路径也顺便测了）
      context: withContext ? [] : undefined,
    },
    stat: { tokenCount: 0, wordCount: 0, charCount: 0 },
    lastUpdate: 1,
    lastSummarizeIndex: 0,
    memoryPrompt: "",
  } as any;
}

describe("stopping a generation", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    ChatControllerPool.controllers = {};
    ChatControllerPool.cancelled.clear();
    // 网络请求永远挂起：测试里不关心它，也不希望产生未处理的 rejection
    (globalThis as any).fetch = () => new Promise(() => {});
  });

  afterEach(() => {
    (globalThis as any).fetch = originalFetch;
  });

  test("stop before the request starts aborts the controller once it arrives", () => {
    ChatControllerPool.stop("s", "m");
    expect(ChatControllerPool.isCancelled("s", "m")).toBe(true);

    const controller = new AbortController();
    ChatControllerPool.addController("s", "m", controller);

    expect(controller.signal.aborted).toBe(true);
    // 记账用完即清，不会一直留着
    expect(ChatControllerPool.isCancelled("s", "m")).toBe(false);
  });

  test("send inserts a streaming placeholder synchronously", () => {
    const session = makeSession(true);
    useChatStore.setState({
      sessions: [session],
      currentSessionIndex: 0,
    } as any);

    // 不 await：占位回复必须在“拼历史”之前就已经存在，
    // 这样停止按钮才能立刻出现
    void useChatStore
      .getState()
      .onUserInput("你好")
      .catch(() => {});

    expect(session.messages).toHaveLength(2);
    expect(session.messages[0].role).toBe("user");
    expect(session.messages[1].role).toBe("assistant");
    expect(session.messages[1].streaming).toBe(true);
  });

  test("stopping right after send removes the placeholder and sends nothing", async () => {
    // 历史组装会立刻抛错，但重点是“取消优先于报错”
    const session = makeSession(false);
    useChatStore.setState({
      sessions: [session],
      currentSessionIndex: 0,
    } as any);

    const pending = useChatStore
      .getState()
      .onUserInput("你好")
      .catch(() => {});

    // 模拟用户立刻点了停止（此时请求还没发出去）
    const placeholder = session.messages[1];
    expect(placeholder.streaming).toBe(true);
    ChatControllerPool.stop(session.id, placeholder.id);

    await pending;

    // 占位被清掉，只剩用户消息；也不会残留取消标记
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0].role).toBe("user");
    expect(ChatControllerPool.isCancelled(session.id, placeholder.id)).toBe(
      false,
    );
  });
});
