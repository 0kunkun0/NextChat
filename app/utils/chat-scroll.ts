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

/** 气泡顶部与容器顶部的间隙，避免文字贴着屏幕边缘 */
export const STREAMING_PIN_GAP = 12;

/**
 * 流式输出时的滚动目标：把「正在生成的那条气泡」的顶部钉在容器顶部。
 *
 * 以前是「气泡没超过一屏就跟着底部走，超过了才停下」——PC 上屏幕高，
 * 回复要涨到超过一屏才开始钉住，在那之前看起来就是"一直在往下滚"；
 * 手机屏幕矮，很快就超过一屏，所以永远像是钉住的。
 * 现在统一成：一开始就把气泡顶部顶到容器顶部，之后内容再长也不跟随。
 *
 * 只往下滚（target 比当前更靠下才动），不会把用户往回拽，
 * 也永远不越过可滚动范围。
 */
export function getStreamingPinTarget(params: {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  /** 消息顶部在滚动内容里的偏移 */
  messageTop: number;
  gap?: number;
}): { target: number; shouldScroll: boolean } {
  const gap = params.gap ?? STREAMING_PIN_GAP;
  const maxScroll = Math.max(0, params.scrollHeight - params.clientHeight);
  const desired = Math.max(0, params.messageTop - gap);
  const target = Math.min(maxScroll, desired);

  return { target, shouldScroll: target > params.scrollTop + 1 };
}
/**
 * 流式期间还要不要继续把气泡钉在顶部。
 *
 * 三个条件分别对应三种“用户已经接管滚动”的情况：
 *   - autoScroll=false：用户往上翻历史；
 *   - manualBottom=true：用户点了「回到底部」按钮；
 *   - userScrolled=true：用户自己滚动过（**任意方向**）。
 *
 * 少了第三条时，用户在生成期间往下滚会被每次渲染拽回气泡顶部，
 * 表现就是「抽搐、卡在原地，生成完才能正常滚」。
 */
export function shouldPinDuringStreaming(params: {
  autoScroll: boolean;
  manualBottom: boolean;
  userScrolled: boolean;
}): boolean {
  return params.autoScroll && !params.manualBottom && !params.userScrolled;
}

/**
 * 这一帧还要不要执行「钉住生成中的气泡」。
 *
 * requestAnimationFrame 是异步的：生成常常在两次渲染之间结束。
 * 以前回调里查不到 `[data-streaming="1"]` 就会走「先贴底」的分支，
 * 于是生成结束的一瞬间被拽到最底部（时有时无，取决于时序）。
 *
 * @param streaming 回调执行时是否仍在流式输出
 * @param hasStreamingElement 当前 DOM 里是否还有生成中的气泡
 */
export function canPinStreamingScroll(params: {
  streaming: boolean;
  hasStreamingElement: boolean;
}): boolean {
  return params.streaming && params.hasStreamingElement;
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
