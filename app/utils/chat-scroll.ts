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
