/**
 * 聊天列表滚动位置的判定。
 *
 * 之前这些判断直接写在组件里，有两个坑：
 * 1. 用「一屏高度」当边缘阈值，滚动还没到边就触发分页，来回跳；
 * 2. 窗口后面还有没渲染的消息时，到达“已加载部分的底部”会被当成真正的底部，
 *    于是自动滚到最后一条——表现就是从历史里往下翻会突然弹到最新消息。
 */
export const CHAT_EDGE_THRESHOLD = 120;

export function getChatScrollState(params: {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  isMobile: boolean;
  /** 渲染窗口后面是否还有未加载的消息 */
  hasMoreBelow: boolean;
}) {
  const { scrollTop, clientHeight, scrollHeight, isMobile, hasMoreBelow } =
    params;
  const bottomHeight = scrollTop + clientHeight;

  const isTouchTopEdge = scrollTop <= CHAT_EDGE_THRESHOLD;
  const isTouchBottomEdge = bottomHeight >= scrollHeight - CHAT_EDGE_THRESHOLD;

  const isHitBottom =
    !hasMoreBelow && bottomHeight >= scrollHeight - (isMobile ? 4 : 10);

  return { isTouchTopEdge, isTouchBottomEdge, isHitBottom };
}

/**
 * 流式输出时的滚动目标。
 *
 * 跟着新内容往下滚，但上限是“正在生成的那条消息”顶部贴住容器顶部：
 * 回复超过一屏之后就停在原地，用户才能往上翻着看已经生成的内容，
 * 而不是每来一段就被拽回底部。
 */
export function getStreamingScrollTarget(params: {
  clientHeight: number;
  scrollHeight: number;
  /** 消息顶部在滚动内容里的偏移 */
  messageTop: number;
}) {
  const bottom = Math.max(0, params.scrollHeight - params.clientHeight);
  const messageTop = Math.max(0, params.messageTop);

  // 气泡还不到一屏时 messageTop 在底部之下，贴底；超过一屏后停在气泡顶部
  const atCap = messageTop <= bottom;

  return {
    bottom,
    atCap,
    target: Math.min(bottom, messageTop),
  };
}
