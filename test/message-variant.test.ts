import {
  ChatMessage,
  addMessageVariant,
  createMessage,
  getMessageVariantCount,
  getMessageVariantIndex,
  snapshotMessage,
  switchMessageVariant,
} from "../app/store/chat";

function makeSingleReply(content = "first reply") {
  return createMessage({
    role: "assistant",
    content,
    model: "gpt-4o",
    date: "2024/1/1 00:00:00",
  });
}

function withVariants(replies: string[]): ChatMessage {
  const message = makeSingleReply(replies[0]);
  replies.forEach((content, index) => {
    const variant = snapshotMessage(
      createMessage({
        role: "assistant",
        content,
        model: "gpt-4o",
        date: `2024/1/1 00:00:0${index}`,
      }),
    );
    if (index === 0) {
      message.variants = [variant];
    } else {
      addMessageVariant(message, variant);
    }
  });
  switchMessageVariant(message, 0);
  return message;
}

describe("message variants", () => {
  test("a message without variants counts as a single reply", () => {
    const message = makeSingleReply();
    expect(getMessageVariantCount(message)).toBe(1);
    expect(getMessageVariantIndex(message)).toBe(0);
  });

  test("counts every candidate and clamps out-of-range index", () => {
    const message = withVariants(["a", "b", "c"]);
    expect(getMessageVariantCount(message)).toBe(3);

    message.variantIndex = 99;
    expect(getMessageVariantIndex(message)).toBe(2);

    message.variantIndex = -1;
    expect(getMessageVariantIndex(message)).toBe(0);
  });

  test("switching candidates swaps the content of the message itself", () => {
    const message = withVariants(["a", "b", "c"]);
    expect(message.content).toBe("a");

    switchMessageVariant(message, 2);
    expect(message.content).toBe("c");
    expect(message.date).toBe("2024/1/1 00:00:02");
    expect(getMessageVariantIndex(message)).toBe(2);

    switchMessageVariant(message, 1);
    expect(message.content).toBe("b");
  });

  test("edits made to the active candidate are kept when switching away", () => {
    const message = withVariants(["a", "b"]);
    switchMessageVariant(message, 0);
    message.content = "edited a";

    switchMessageVariant(message, 1);
    switchMessageVariant(message, 0);

    expect(message.content).toBe("edited a");
  });

  test("adding a candidate keeps the previous reply and activates the new one", () => {
    const message = makeSingleReply("old reply");
    const index = addMessageVariant(
      message,
      snapshotMessage(
        createMessage({ role: "assistant", content: "new reply" }),
      ),
    );

    expect(index).toBe(1);
    expect(getMessageVariantCount(message)).toBe(2);
    expect(getMessageVariantIndex(message)).toBe(1);
    expect(message.content).toBe("new reply");
    expect(message.variants?.at(0)?.content).toBe("old reply");

    switchMessageVariant(message, 0);
    expect(message.content).toBe("old reply");
  });

  test("legacy messages (no variants field) keep working and upgrade lazily", () => {
    // 模拟旧版本持久化下来的消息：没有 variants / variantIndex
    const legacy = JSON.parse(
      JSON.stringify([{ id: "a1", role: "assistant", content: "hello" }]),
    ) as ChatMessage[];
    legacy[0].date = "2024/1/1 00:00:00";

    // 1. 旧消息被当成只有 1 个候选，切换器不会出现
    expect(getMessageVariantCount(legacy[0])).toBe(1);
    expect(getMessageVariantIndex(legacy[0])).toBe(0);

    // 2. 越界切换不会破坏内容
    switchMessageVariant(legacy[0], 3);
    expect(legacy[0].content).toBe("hello");
    expect(getMessageVariantCount(legacy[0])).toBe(1);

    // 3. 第一次重新生成时，旧内容才被升级成候选 1
    addMessageVariant(
      legacy[0],
      snapshotMessage(
        createMessage({ role: "assistant", content: "regenerated" }),
      ),
    );
    expect(getMessageVariantCount(legacy[0])).toBe(2);
    expect(legacy[0].variants?.at(0)?.content).toBe("hello");
    expect(legacy[0].variants?.at(0)?.date).toBe("2024/1/1 00:00:00");
    expect(legacy[0].content).toBe("regenerated");

    // 4. 切回旧回复，内容与时间戳都还在
    switchMessageVariant(legacy[0], 0);
    expect(legacy[0].content).toBe("hello");
    expect(legacy[0].date).toBe("2024/1/1 00:00:00");
  });
});
