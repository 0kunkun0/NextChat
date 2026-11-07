import { useChatStore } from "../app/store/chat";

function makeSession(messages: any[]) {
  return {
    id: "s1",
    topic: "t",
    messages,
    mask: {},
    stat: { tokenCount: 0, wordCount: 0, charCount: 0 },
    lastUpdate: 1,
    lastSummarizeIndex: 0,
    memoryPrompt: "",
  } as any;
}

describe("isComplete / interrupted generation", () => {
  test("messages are complete by default", () => {
    useChatStore.setState({
      sessions: [
        makeSession([
          { id: "m1", role: "assistant", content: "done", date: "" },
        ]),
      ],
      currentSessionIndex: 0,
    } as any);

    expect(useChatStore.getState().sessions[0].messages[0].isComplete).toBe(
      undefined,
    );
  });

  test("an interrupted stream is marked incomplete so it can be continued", () => {
    useChatStore.setState({
      sessions: [
        makeSession([
          {
            id: "m1",
            role: "assistant",
            content: "half of the answer",
            date: "",
            streaming: true,
          },
          { id: "m2", role: "assistant", content: "done", date: "" },
        ]),
      ],
      currentSessionIndex: 0,
    } as any);

    useChatStore.getState().repairInterruptedMessages();

    const [interrupted, finished] =
      useChatStore.getState().sessions[0].messages;
    expect(interrupted.streaming).toBe(false);
    expect(interrupted.isComplete).toBe(false);
    // 已经完成的消息不受影响
    expect(finished.isComplete).toBeUndefined();
  });

  test("does nothing when nothing is streaming", () => {
    const session = makeSession([
      { id: "m1", role: "assistant", content: "done", date: "" },
    ]);
    useChatStore.setState({
      sessions: [session],
      currentSessionIndex: 0,
    } as any);

    const before = useChatStore.getState().sessions;
    useChatStore.getState().repairInterruptedMessages();

    expect(useChatStore.getState().sessions).toBe(before);
  });
});
