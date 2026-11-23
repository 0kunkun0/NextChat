import {
  getStreamingPinTarget,
  STREAMING_PIN_GAP,
} from "../app/utils/chat-scroll";

/**
 * 桌面端「气泡钉在画面顶部」的实现依赖列表末尾那块占位空白：
 * 有了它，即使答复还很短，messageTop 也是可以达到的滚动位置。
 * 这里验证的就是这个前提（spacer = 一屏高时，target 一定等于 messageTop）。
 */
function withSpacer(params: {
  clientHeight: number;
  messageTop: number;
  bubbleHeight: number;
}) {
  const { clientHeight, messageTop, bubbleHeight } = params;
  // 末尾垫一块 clientHeight 高的空白
  const scrollHeight = messageTop + bubbleHeight + clientHeight;
  return getStreamingPinTarget({
    scrollTop: 0,
    clientHeight,
    scrollHeight,
    messageTop,
  });
}

describe("桌面端钉顶（末尾有占位空白）", () => {
  test("答复很短时也能把气泡顶部滚到画面顶部", () => {
    const result = withSpacer({
      clientHeight: 800,
      messageTop: 1200,
      bubbleHeight: 120,
    });
    expect(result.target).toBe(1200 - STREAMING_PIN_GAP);
    expect(result.shouldScroll).toBe(true);
  });

  test("答复超过一屏后同样停在气泡顶部，不会继续往下滚", () => {
    const result = withSpacer({
      clientHeight: 800,
      messageTop: 900,
      bubbleHeight: 4000,
    });
    expect(result.target).toBe(900 - STREAMING_PIN_GAP);
  });

  test("没有占位空白时（移动端）只能滚到底部", () => {
    const result = getStreamingPinTarget({
      scrollTop: 0,
      clientHeight: 800,
      scrollHeight: 1400, // 气泡在 1200，下面只有 200
      messageTop: 1200,
    });
    // maxScroll = 600，够不到 1188
    expect(result.target).toBe(600);
  });
});
