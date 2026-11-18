import {
  getPendingLogs,
  installConsoleHook,
  installErrorHook,
  compactChatPayload,
  previewText,
  setIncludeContent,
  uninstallConsoleHook,
  uninstallErrorHook,
  useDebugLogStore,
} from "../app/store/debug-log";

describe("debug log console hook", () => {
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };

  afterEach(() => {
    uninstallConsoleHook();
    uninstallErrorHook();
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
    useDebugLogStore.getState().setEnabled(false);
  });

  test("wraps console methods and still forwards to the original", () => {
    const calls: unknown[][] = [];
    const base = (...args: unknown[]) => {
      calls.push(args);
    };
    console.log = base as any;

    installConsoleHook();
    const hooked = console.log;
    expect(hooked).not.toBe(base);

    console.log("hello", 1);
    expect(calls).toEqual([["hello", 1]]);

    uninstallConsoleHook();
    expect(console.log).toBe(base);

    console.log("after");
    expect(calls).toEqual([["hello", 1], ["after"]]);
  });

  test("does not wrap twice", () => {
    installConsoleHook();
    const once = console.log;
    installConsoleHook();
    expect(console.log).toBe(once);
  });

  test("logging inside the hook never recurses", () => {
    const calls: unknown[][] = [];
    console.log = ((...args: unknown[]) => {
      calls.push(args);
    }) as any;

    installConsoleHook();
    // 模拟“日志系统自己也在打日志”的场景，不能卡死
    console.log("a");
    console.log("b");
    expect(calls.length).toBe(2);
  });

  test("setEnabled installs and removes the hook", () => {
    const base = console.log;
    useDebugLogStore.getState().setEnabled(true);
    expect(useDebugLogStore.getState().enabled).toBe(true);
    expect(console.log).not.toBe(base);

    useDebugLogStore.getState().setEnabled(false);
    expect(useDebugLogStore.getState().enabled).toBe(false);
    expect(console.log).toBe(base);
  });

  test("compactChatPayload 把对话数组压成「条数 + 最后一条末尾」", () => {
    const payload = {
      model: "deepseek-chat",
      temperature: 0.5,
      messages: [
        { role: "system", content: "你是一个很长的系统提示词".repeat(20) },
        { role: "user", content: "中间这条内容不应该出现在日志里" },
        {
          role: "assistant",
          content: "这是最后一条消息，结尾很重要结尾很重要尾十个字",
        },
      ],
    };

    const compacted = compactChatPayload(payload);

    // 元信息保留
    expect(compacted.model).toBe("deepseek-chat");
    expect(compacted.temperature).toBe(0.5);
    // 对话被压成摘要
    expect(compacted.messages).toBeUndefined();
    expect(compacted.messagesCount).toBe(3);
    expect(compacted.messagesLastRole).toBe("assistant");
    // 只保留最后 10 个字符（末尾带 (+省略字数) 方便判断原文有多长）
    expect(String(compacted.messagesLastTail)).toContain("尾十个字");
    expect(String(compacted.messagesLastTail)).toContain("…");

    // 整段序列化后不含任何正文
    const json = JSON.stringify(compacted);
    expect(json).not.toContain("中间这条内容");
    expect(json).not.toContain("你是一个很长的系统提示词");
  });

  test("compactChatPayload 不会在循环引用上死循环", () => {
    const payload: any = { model: "m" };
    payload.self = payload;
    payload.messages = [{ role: "user", content: "hi" }];

    expect(() => JSON.stringify(compactChatPayload(payload))).not.toThrow();
  });

  test("previewText 受「日志包含对话内容」开关控制", () => {
    const long = "a".repeat(200);

    // 默认关闭：只留前 10 个字符
    setIncludeContent(false);
    expect(previewText(long)).toBe(`aaaaaaaaaa…(+190)`);
    // 短文本不受影响
    expect(previewText("short")).toBe("short");

    // 打开后原样保留
    setIncludeContent(true);
    expect(previewText(long)).toBe(long);
    expect(previewText(long)).toHaveLength(200);

    // 关掉恢复截断
    setIncludeContent(false);
    expect(previewText(long)).toContain("…(+190)");
  });

  test("long message content is truncated to a short preview", () => {
    console.log = (() => {}) as any;
    installConsoleHook();

    const content = "这是一段很长的对话内容".repeat(50);
    const before = getPendingLogs().length;
    console.log("[Request] payload: ", {
      model: "gpt-4",
      messages: [{ role: "user", content }],
    });

    const pending = getPendingLogs();
    expect(pending.length).toBe(before + 1);
    const text = pending[pending.length - 1].text;

    // 短字段原样保留；对话被压成「条数 + 最后一条末尾 10 个字」
    expect(text).toContain("gpt-4");
    expect(text).toContain("messagesCount");
    expect(text).toContain(content.slice(-10));
    // 整段原文不能出现
    expect(text).not.toContain("这是一段很长的对话内容".repeat(5));
    expect(text).not.toContain("这是一段很长的对话内容".repeat(2));
    // 带上总长度，方便判断原来有多长
    expect(text).toContain(`(+${content.length - 10})`);
  });
});

describe("uncaught error capture", () => {
  test("records window error events", () => {
    installErrorHook();
    const before = getPendingLogs().length;

    const error = new Error("boom");
    window.dispatchEvent(
      new ErrorEvent("error", {
        message: "boom",
        error,
        filename: "app.js",
        lineno: 12,
        colno: 3,
      }),
    );

    const pending = getPendingLogs();
    expect(pending.length).toBe(before + 1);
    const last = pending[pending.length - 1];
    expect(last.level).toBe("error");
    expect(last.text).toContain("[uncaught]");
    expect(last.text).toContain("boom");
    expect(last.text).toContain("app.js:12:3");
  });

  test("records unhandled promise rejections", () => {
    installErrorHook();
    const before = getPendingLogs().length;

    // jsdom 没有 PromiseRejectionEvent 构造函数，手工造一个同类事件
    const event = new Event("unhandledrejection") as any;
    event.reason = new Error("nobody caught me");
    window.dispatchEvent(event);

    const pending = getPendingLogs();
    expect(pending.length).toBe(before + 1);
    const last = pending[pending.length - 1];
    expect(last.level).toBe("error");
    expect(last.text).toContain("[unhandled rejection]");
    expect(last.text).toContain("nobody caught me");
  });

  test("does not double-install listeners", () => {
    installErrorHook();
    installErrorHook();
    const before = getPendingLogs().length;
    window.dispatchEvent(new ErrorEvent("error", { message: "once" }));
    expect(getPendingLogs().length).toBe(before + 1);
  });
});
