import { act, renderHook } from "@testing-library/react";
import { jest } from "@jest/globals";

import { useThrottleMarkdownRender } from "../app/utils/use-throttle-markdown";

/**
 * 流式节流：内容更新不是每个 token 都立刻重建，而是按上次渲染耗时排期，
 * 但流式结束（streaming=false）时必须立刻用完整内容。
 */
describe("useThrottleMarkdownRender", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("非流式时永远返回最新内容（不节流）", () => {
    const { result, rerender } = renderHook(
      ({ content, streaming }) => useThrottleMarkdownRender(content, streaming),
      { initialProps: { content: "a", streaming: false } },
    );

    expect(result.current).toBe("a");
    rerender({ content: "ab", streaming: false });
    expect(result.current).toBe("ab");
    rerender({ content: "abc", streaming: false });
    expect(result.current).toBe("abc");
  });

  test("流式结束后立刻返回完整内容", () => {
    const { result, rerender } = renderHook(
      ({ content, streaming }) => useThrottleMarkdownRender(content, streaming),
      { initialProps: { content: "第一段", streaming: true } },
    );

    // 流式进行中：连续更新会被合并
    rerender({ content: "第一段第二段", streaming: true });
    rerender({ content: "第一段第二段第三段", streaming: true });

    // 结束流式：立即拿到最终内容
    rerender({ content: "第一段第二段第三段", streaming: false });
    expect(result.current).toBe("第一段第二段第三段");
  });

  test("流式过程中最终会把最新内容渲染出来", () => {
    const { result, rerender } = renderHook(
      ({ content, streaming }) => useThrottleMarkdownRender(content, streaming),
      { initialProps: { content: "a", streaming: true } },
    );

    rerender({ content: "ab", streaming: true });
    rerender({ content: "abc", streaming: true });

    // 推进定时器：排期到了之后应该跟上最新内容
    act(() => {
      jest.advanceTimersByTime(3000);
    });

    expect(result.current).toBe("abc");
  });

  test("内容没变时不额外触发更新", () => {
    const { result, rerender } = renderHook(
      ({ content, streaming }) => useThrottleMarkdownRender(content, streaming),
      { initialProps: { content: "稳定内容", streaming: true } },
    );

    rerender({ content: "稳定内容", streaming: true });
    act(() => {
      jest.advanceTimersByTime(3000);
    });

    expect(result.current).toBe("稳定内容");
  });
});
