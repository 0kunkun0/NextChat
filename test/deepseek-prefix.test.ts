// 先加载 store/chat：它会先一步初始化 locales，避免 @/app/store 的循环依赖踩到时序
import "../app/store/chat";
import { DeepSeekApi } from "../app/client/platforms/deepseek";

type Captured = { url: string; body: any };

function installFakeFetch() {
  const captured: Captured[] = [];

  (globalThis as any).fetch = async (url: string, init: any = {}) => {
    captured.push({
      url: String(url),
      body: init.body ? JSON.parse(String(init.body)) : null,
    });

    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        choices: [{ message: { content: "……继续写的内容" } }],
      }),
      text: async () => "",
    } as any;
  };

  return captured;
}

const config = { model: "deepseek-chat", stream: false } as any;

describe("DeepSeek prefix completion", () => {
  test("normal chat does not use the beta endpoint or prefix flag", async () => {
    const captured = installFakeFetch();
    const api = new DeepSeekApi();

    await api.chat({
      messages: [
        { role: "user", content: "写一段话" },
        { role: "assistant", content: "这是开头" },
      ],
      config,
      onFinish: () => {},
    });

    const chatCalls = captured.filter((c) =>
      c.url.includes("/chat/completions"),
    );
    expect(chatCalls).toHaveLength(1);
    expect(chatCalls[0].url).toBe("/api/deepseek/chat/completions");
    const last = chatCalls[0].body.messages.at(-1);
    expect(last.prefix).toBeUndefined();
  });

  test("prefix mode hits /beta and flags the last assistant message", async () => {
    const captured = installFakeFetch();
    const api = new DeepSeekApi();
    let finished = "";

    await api.chat({
      messages: [
        { role: "user", content: "写一段话" },
        { role: "assistant", content: "这是开头，后面还没写完" },
      ],
      config,
      prefix: true,
      onFinish: (message: string) => {
        finished = message;
      },
    });

    const chatCalls = captured.filter((c) =>
      c.url.includes("/chat/completions"),
    );
    expect(chatCalls).toHaveLength(1);
    // 前缀补全是 beta 功能
    expect(chatCalls[0].url).toBe("/api/deepseek/beta/chat/completions");

    const last = chatCalls[0].body.messages.at(-1);
    expect(last.role).toBe("assistant");
    // 已经写出来的半截原样发回去
    expect(last.content).toBe("这是开头，后面还没写完");
    expect(last.prefix).toBe(true);

    // 只返回续写的部分
    expect(finished).toBe("……继续写的内容");
  });
});
