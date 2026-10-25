import { getMessageTextContentWithoutThinking } from "../app/utils";

function assistant(content: any) {
  return { role: "assistant", content } as any;
}

describe("getMessageTextContentWithoutThinking", () => {
  test("keeps paragraph breaks between answer paragraphs", () => {
    const message = assistant("> 先想一想\n\n第一段\n\n第二段");
    expect(getMessageTextContentWithoutThinking(message)).toBe(
      "第一段\n\n第二段",
    );
  });

  test("keeps consecutive blank lines intact", () => {
    const message = assistant("a\n\n\nb");
    expect(getMessageTextContentWithoutThinking(message)).toBe("a\n\n\nb");
  });

  test("strips every thinking line, including the ones inside a thinking block", () => {
    const message = assistant(
      "> thinking 1\n> thinking 2\n\n答案\n\n> 不应保留",
    );
    expect(getMessageTextContentWithoutThinking(message)).toBe("答案");
  });

  test("reads the text part of multimodal content", () => {
    const message = assistant([
      { type: "text", text: "x\n\ny" },
      { type: "image_url", image_url: { url: "data:image/png;base64,aa" } },
    ]);
    expect(getMessageTextContentWithoutThinking(message)).toBe("x\n\ny");
  });

  test("a message that is only thinking becomes empty", () => {
    expect(getMessageTextContentWithoutThinking(assistant("> a\n> b"))).toBe(
      "",
    );
  });

  test("trims only the outer whitespace", () => {
    const message = assistant("\n\n  答案  \n\n");
    expect(getMessageTextContentWithoutThinking(message)).toBe("答案");
  });
});
