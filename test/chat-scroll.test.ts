import {
  CHAT_EDGE_THRESHOLD,
  getChatScrollState,
  getStreamingScrollTarget,
  isScrollContentShort,
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

describe("getStreamingScrollTarget", () => {
  test("follows the bottom while the reply is shorter than one screen", () => {
    // 内容 1000，视口 800 → 底部是 200；气泡顶部在 600（还没到顶）
    const result = getStreamingScrollTarget({
      clientHeight: 800,
      scrollHeight: 1000,
      messageTop: 600,
    });

    expect(result.target).toBe(200);
    expect(result.atCap).toBe(false);
  });

  test("stops at the bubble top once the reply is taller than one screen", () => {
    // 内容 3000，视口 800 → 底部 2200；气泡顶部在 900
    const result = getStreamingScrollTarget({
      clientHeight: 800,
      scrollHeight: 3000,
      messageTop: 900,
    });

    expect(result.target).toBe(900);
    expect(result.atCap).toBe(true);
  });

  test("never scrolls past the bottom", () => {
    const result = getStreamingScrollTarget({
      clientHeight: 800,
      scrollHeight: 900,
      messageTop: 5000,
    });
    expect(result.target).toBe(100);
  });

  test("handles a message that starts at the very top", () => {
    const result = getStreamingScrollTarget({
      clientHeight: 800,
      scrollHeight: 2000,
      messageTop: 0,
    });
    expect(result.target).toBe(0);
    expect(result.atCap).toBe(true);
  });

  test("handles content shorter than the viewport", () => {
    const result = getStreamingScrollTarget({
      clientHeight: 800,
      scrollHeight: 400,
      messageTop: 300,
    });
    expect(result.bottom).toBe(0);
    expect(result.target).toBe(0);
  });
});

describe("isScrollContentShort", () => {
  test("detects content shorter than the viewport", () => {
    expect(isScrollContentShort({ clientHeight: 800, scrollHeight: 700 })).toBe(
      true,
    );
  });

  test("counts content that barely overflows as short", () => {
    // 只比视口高一点点时滚动条几乎没有行程，滚不到“顶部”触发加载
    expect(isScrollContentShort({ clientHeight: 800, scrollHeight: 900 })).toBe(
      true,
    );
  });

  test("tall content is not short", () => {
    expect(
      isScrollContentShort({ clientHeight: 800, scrollHeight: 2000 }),
    ).toBe(false);
  });
});
