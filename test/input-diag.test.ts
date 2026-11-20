import { jest } from "@jest/globals";

import { attachInputDiagnostics } from "../app/utils/input-diag";

/**
 * iOS 15 上「选中文字 → 系统菜单（共享/翻译/查询）」偶尔会把选中的文字吞掉。
 * 这里测试的是兜底逻辑：内容大幅变短、且最近没有键盘输入时，恢复旧值。
 */
describe("attachInputDiagnostics", () => {
  function makeTextarea(initial: string) {
    const el = document.createElement("textarea");
    el.value = initial;
    document.body.appendChild(el);
    return el;
  }

  afterEach(() => {
    document.body.innerHTML = "";
  });

  test("正常输入不会触发恢复", () => {
    const el = makeTextarea("hello");
    const onSuspect = jest.fn();
    const detach = attachInputDiagnostics(el, { onSuspect });

    el.value = "hello world";
    el.dispatchEvent(new Event("input"));

    expect(onSuspect).not.toHaveBeenCalled();
    detach();
  });

  test("大幅变短且没有键盘输入时恢复原值", () => {
    const el = makeTextarea("这是一段比较长的输入内容，用来模拟被系统吞掉");
    const onSuspect = jest.fn();
    const detach = attachInputDiagnostics(el, { onSuspect });

    // 模拟 iOS 把选中的文字整体吞掉
    el.value = "这是一段";
    el.dispatchEvent(new Event("input"));

    expect(onSuspect).toHaveBeenCalledTimes(1);
    expect(onSuspect.mock.calls[0][0]).toBe(
      "这是一段比较长的输入内容，用来模拟被系统吞掉",
    );
    // DOM 也要恢复
    expect(el.value).toBe("这是一段比较长的输入内容，用来模拟被系统吞掉");
    detach();
  });

  test("用户自己删除（有键盘输入）不会被当成误删", () => {
    const el = makeTextarea("这是一段比较长的输入内容，用来模拟被系统吞掉");
    const onSuspect = jest.fn();
    const detach = attachInputDiagnostics(el, { onSuspect });

    // 先有一次键盘操作
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace" }));

    el.value = "这是一段";
    el.dispatchEvent(new Event("input"));

    expect(onSuspect).not.toHaveBeenCalled();
    expect(el.value).toBe("这是一段");
    detach();
  });

  test("小幅变短（少于阈值）不触发", () => {
    const el = makeTextarea("hello world");
    const onSuspect = jest.fn();
    const detach = attachInputDiagnostics(el, { onSuspect });

    el.value = "hello wor"; // 少 2 个字符
    el.dispatchEvent(new Event("input"));

    expect(onSuspect).not.toHaveBeenCalled();
    detach();
  });

  test("值被静默改小（没有 input 事件）也能恢复", () => {
    jest.useFakeTimers();
    const original = "这是一段比较长的输入内容，用来模拟被系统吞掉";
    const el = makeTextarea(original);
    const onSuspect = jest.fn();
    const detach = attachInputDiagnostics(el, { onSuspect });

    // 聚焦后开启静默检测
    el.dispatchEvent(new FocusEvent("focus"));
    // 系统直接改 DOM，不派发任何事件
    el.value = "这是一段";

    jest.advanceTimersByTime(500);

    expect(onSuspect).toHaveBeenCalledTimes(1);
    expect(el.value).toBe(original);

    detach();
    jest.useRealTimers();
  });

  test("发送后清空输入框不会被兜底逻辑还原回来", () => {
    jest.useFakeTimers();
    const original = "这是要发送的一段文字，发送后应该清空";
    const el = makeTextarea(original);
    const onSuspect = jest.fn();

    // 模拟受控组件的 state
    let state = original;
    const detach = attachInputDiagnostics(el, {
      onSuspect,
      getExpectedValue: () => state,
    });

    el.dispatchEvent(new FocusEvent("focus"));

    // 发送：应用自己把 state 和 DOM 都清空（不会派发 input 事件）
    state = "";
    el.value = "";

    jest.advanceTimersByTime(1000);

    expect(onSuspect).not.toHaveBeenCalled();
    expect(el.value).toBe("");

    detach();
    jest.useRealTimers();
  });

  test("系统静默吞掉内容时（state 仍是原文）仍然会恢复", () => {
    jest.useFakeTimers();
    const original = "这是一段比较长的输入内容，用来模拟被系统吞掉";
    const el = makeTextarea(original);
    const onSuspect = jest.fn();

    // state 没变，只有 DOM 被系统改了 → 应该恢复
    let state = original;
    const detach = attachInputDiagnostics(el, {
      onSuspect,
      getExpectedValue: () => state,
    });

    el.dispatchEvent(new FocusEvent("focus"));
    el.value = "这是一段";

    jest.advanceTimersByTime(500);

    expect(onSuspect).toHaveBeenCalledTimes(1);
    expect(el.value).toBe(original);

    detach();
    jest.useRealTimers();
  });

  test("detach 之后不再监听", () => {
    const el = makeTextarea("这是一段比较长的输入内容");
    const onSuspect = jest.fn();
    const detach = attachInputDiagnostics(el, { onSuspect });
    detach();

    el.value = "短";
    el.dispatchEvent(new Event("input"));

    expect(onSuspect).not.toHaveBeenCalled();
  });
});
