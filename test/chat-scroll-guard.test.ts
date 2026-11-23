import { canPinStreamingScroll } from "../app/utils/chat-scroll";

/**
 * 生成结束时“自己滚到最底”的根因：
 *
 * requestAnimationFrame 是异步的。生成在这两帧之间结束时，
 * 回调里查不到 `[data-streaming="1"]`，旧逻辑会走“气泡还没渲染 → 先贴底”，
 * 于是什么都没做却被拽到最底部（时有时无，取决于时序）。
 */
describe("canPinStreamingScroll", () => {
  test("仍在流式 + 有生成中的气泡 → 允许滚动", () => {
    expect(
      canPinStreamingScroll({ streaming: true, hasStreamingElement: true }),
    ).toBe(true);
  });

  test("生成已经结束（尽管气泡可能还在 DOM 里）→ 不动滚动", () => {
    expect(
      canPinStreamingScroll({ streaming: false, hasStreamingElement: true }),
    ).toBe(false);
  });

  test("气泡还没渲染出来 → 不动滚动（贴底交给 resetFollow）", () => {
    expect(
      canPinStreamingScroll({ streaming: true, hasStreamingElement: false }),
    ).toBe(false);
  });

  test("都没了 → 不动滚动", () => {
    expect(
      canPinStreamingScroll({ streaming: false, hasStreamingElement: false }),
    ).toBe(false);
  });
});
