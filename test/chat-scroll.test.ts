import {
  CHAT_EDGE_THRESHOLD,
  getChatScrollState,
} from "../app/utils/chat-scroll";

const base = { clientHeight: 800, isMobile: false, hasMoreBelow: false };

describe("getChatScrollState", () => {
  test("is not at the top when scrolled past the edge threshold", () => {
    const state = getChatScrollState({
      ...base,
      scrollTop: CHAT_EDGE_THRESHOLD + 1,
      scrollHeight: 4000,
    });
    expect(state.isTouchTopEdge).toBe(false);
  });

  test("loads earlier messages slightly before the very top", () => {
    const state = getChatScrollState({
      ...base,
      scrollTop: CHAT_EDGE_THRESHOLD - 10,
      scrollHeight: 4000,
    });
    expect(state.isTouchTopEdge).toBe(true);
  });

  test("the bottom of a partial window is not the real bottom", () => {
    // 已加载部分的底部，但后面还有没渲染的消息
    const state = getChatScrollState({
      ...base,
      scrollTop: 4000 - 800,
      scrollHeight: 4000,
      hasMoreBelow: true,
    });

    expect(state.isTouchBottomEdge).toBe(true);
    // 关键：不能当成真正的底部，否则会自动滚到最新一条
    expect(state.isHitBottom).toBe(false);
  });

  test("the real bottom is detected", () => {
    const state = getChatScrollState({
      ...base,
      scrollTop: 4000 - 800,
      scrollHeight: 4000,
      hasMoreBelow: false,
    });
    expect(state.isHitBottom).toBe(true);
  });

  test("mobile uses a slightly tighter bottom tolerance", () => {
    // 距离底部 8px：桌面算到底，移动端不算
    const params = {
      ...base,
      scrollTop: 4000 - 800 - 8,
      scrollHeight: 4000,
      hasMoreBelow: false,
    };
    expect(getChatScrollState(params).isHitBottom).toBe(true);
    expect(getChatScrollState({ ...params, isMobile: true }).isHitBottom).toBe(
      false,
    );
  });
});
