import {
  installConsoleHook,
  uninstallConsoleHook,
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
});
