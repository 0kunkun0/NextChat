import { useChatStore } from "../app/store/chat";

/**
 * currentSession() 是「发送消息」链路的起点：
 * getHeaders() / 各平台 path() 都会读 currentSession().mask.modelConfig。
 * 一旦它返回 undefined 或 return 的会话缺 mask，用户按下发送就会直接 TypeError。
 */
describe("currentSession guards", () => {
  test("returns a usable session when the session list is empty", () => {
    useChatStore.setState({ sessions: [], currentSessionIndex: 0 } as any);

    const session = useChatStore.getState().currentSession();

    expect(session).toBeTruthy();
    expect(session.mask).toBeTruthy();
    expect(session.mask.modelConfig).toBeTruthy();
    // 顺手把 state 修好
    expect(useChatStore.getState().sessions).toHaveLength(1);
    expect(useChatStore.getState().currentSessionIndex).toBe(0);
  });

  test("repairs a session that is missing mask", () => {
    const broken = {
      id: "broken",
      topic: "坏的会话",
      messages: [],
      lastUpdate: 1,
      lastSummarizeIndex: 0,
      memoryPrompt: "",
    };
    useChatStore.setState({
      sessions: [broken as any],
      currentSessionIndex: 0,
    } as any);

    const session = useChatStore.getState().currentSession();

    expect(session.id).toBe("broken");
    expect(session.mask).toBeTruthy();
    expect(session.mask.modelConfig).toBeTruthy();
    // 修好之后要写回 store，别每次调用都重新修
    expect(useChatStore.getState().sessions[0].mask).toBeTruthy();
  });

  test("clamps an out-of-range index", () => {
    const session = useChatStore.getState().sessions[0] ?? { id: "x" };
    useChatStore.setState({
      sessions: [{ ...(session as any) }],
      currentSessionIndex: 99,
    } as any);

    const current = useChatStore.getState().currentSession();
    expect(current).toBeTruthy();
    expect(useChatStore.getState().currentSessionIndex).toBe(0);
  });
});
