/**
 * 「编辑消息记录」弹窗的窗口化参数。
 *
 * 弹窗里每条消息都是一个可编辑的 textarea，长对话（几百条）一次性全渲染时
 * DOM 和文本会占用大量内存，低端手机/iOS 上打开就直接被浏览器杀进程。
 * 所以只渲染最近的一段，更早的按需点按钮加载。
 */

/** 一次最多渲染多少条 */
export const CONTEXT_PAGE_SIZE = 40;

/**
 * 计算当前要渲染的消息窗口：从最后一条往前取 `count` 条。
 * @param total 消息总数
 * @param count 期望渲染的条数
 */
export function getContextWindow(total: number, count: number) {
  const safeTotal = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
  const requested = Number.isFinite(count) ? Math.floor(count) : 0;
  const visible = Math.max(0, Math.min(safeTotal, requested));
  const start = safeTotal - visible;

  return {
    /** 第一条渲染项在原始数组里的下标 */
    start,
    /** 实际渲染的条数 */
    visible,
    /** 还有多少条更早的没渲染 */
    hidden: start,
    /** 全部渲染出来了才能启用拖拽排序（否则下标对不上） */
    draggable: start === 0,
  };
}
