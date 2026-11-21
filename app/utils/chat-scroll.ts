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
 * 渲染内容装不满一屏（短消息、低占用模式）。
 *
 * 这种情况下滚动条没有可滚动的空间，`scroll` 事件根本不会触发，
 * 光靠“滚到顶部再加载”永远补不进更早的历史，必须主动检查。
 */
export function isScrollContentShort(params: {
  clientHeight: number;
  scrollHeight: number;
  threshold?: number;
}) {
  const threshold = params.threshold ?? CHAT_EDGE_THRESHOLD;
  return params.scrollHeight <= params.clientHeight + threshold;
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
/* --------------------------- 渲染窗口（分页） --------------------------- */

/**
 * 渲染窗口的起始下标。
 *
 * 上限是 	otal - pageSize（保证底部那一屏还在窗口里），下限是 0。
 * 以前“能不能往前翻”是用 index - pageSize >= 0 判断的，于是
 * 16~29 条这种「不够两页」的会话会被夹在 index=1..14 上，
 * 前面那几条永远加载不出来 —— 滚到最顶上就是看不到第一条消息。
 */
export function clampRenderIndex(
  total: number,
  pageSize: number,
  index: number,
): number {
  const max = Math.max(0, total - pageSize);
  return Math.max(0, Math.min(max, index));
}

/** 窗口前面还有没渲染的消息（只要有就该能继续往前翻） */
export function canLoadEarlier(index: number): boolean {
  return index > 0;
}

/** 往上翻一页的起点，夹到 0 */
export function prevPageIndex(index: number, pageSize: number): number {
  return Math.max(0, index - pageSize);
}
