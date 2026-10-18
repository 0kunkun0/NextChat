import { useChatStore } from "../app/store/chat";

describe("onUserInput", () => {
  beforeEach(() => {
    useChatStore.getState().clearSessions();
  });

  test("keeps the user message even when assembling history throws", async () => {
    const store = useChatStore.getState();
    const session = store.currentSession();

    // 模拟历史组装阶段的意外异常（MCP server action / 配置读取在低配环境下都可能这样炸）
    store.updateTargetSession(session, (target) => {
      (target.mask as any).context = undefined;
    });

    const promise = store.onUserInput("survive me");

    // 关键：还没 await，user 消息就应该已经写进会话了
    const syncSession = useChatStore.getState().currentSession();
    expect(syncSession.messages.at(-1)?.role).toBe("user");
    expect(String(syncSession.messages.at(-1)?.content)).toContain(
      "survive me",
    );

    // 失败不应该变成 rejected promise（unhandled rejection 会把页面带崩）
    await expect(promise).resolves.toBeUndefined();

    const afterFailure = useChatStore.getState().currentSession();
    const userMessage = afterFailure.messages.at(-2);
    expect(userMessage?.role).toBe("user");
    expect(String(userMessage?.content)).toContain("survive me");

    // 失败原因落在一条错误回复上，方便直接点「重新生成」重试
    const botMessage = afterFailure.messages.at(-1);
    expect(botMessage?.role).toBe("assistant");
    expect(botMessage?.isError).toBe(true);
  });
});
