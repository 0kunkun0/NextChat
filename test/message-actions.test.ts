import { shouldShowMessageActions } from "../app/utils/message-actions";

function message(override: any = {}) {
  return {
    id: "m1",
    role: "assistant",
    content: "",
    date: "",
    ...override,
  } as any;
}

describe("shouldShowMessageActions", () => {
  test("hides actions for the first message and for context messages", () => {
    expect(shouldShowMessageActions(message({ content: "hi" }), false, 0)).toBe(
      false,
    );
    expect(shouldShowMessageActions(message({ content: "hi" }), true, 1)).toBe(
      false,
    );
  });

  test("shows actions for a normal message with content", () => {
    expect(shouldShowMessageActions(message({ content: "hi" }), false, 1)).toBe(
      true,
    );
  });

  test("keeps actions visible while streaming with empty content", () => {
    // 重新生成刚点下去、内容已清空但还没吐出第一个字：
    // 这时候必须能看到「停止」，不能整行消失
    expect(
      shouldShowMessageActions(
        message({ content: "", streaming: true }),
        false,
        1,
      ),
    ).toBe(true);
  });

  test("hides actions for an empty message that is not generating", () => {
    expect(shouldShowMessageActions(message({ content: "" }), false, 1)).toBe(
      false,
    );
  });

  test("never shows actions for a preview message", () => {
    expect(
      shouldShowMessageActions(
        message({ content: "hi", preview: true }),
        false,
        1,
      ),
    ).toBe(false);
  });
});
