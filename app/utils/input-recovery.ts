/**
 * iOS 15 「选中文字 → 系统菜单（翻译 / 查询）→ 文字被吞」的判定。
 *
 * 关键点：**只看有没有 input 事件，不看内容长度**。
 *
 *   - 正常输入、拼音选词、自动更正、听写：一定会伴随 `input` 事件；
 *   - 只有系统菜单这条路会出现「DOM 变了，但一个 input 事件都没有」。
 *
 * 之前那版兜底是用「内容变短 > 8 字符 且 1.5s 内没按键」判断的，
 * 结果拼音选前半部分候选词时内容会短暂变短 → 误判成误删，反而打断输入。
 *
 * @param inputEventsWhileAway 失焦期间收到的 input 事件数
 * @param domValue 当前 textarea 的真实值
 * @param expectedValue 应用状态里“应该有”的值
 */
export function shouldRestoreLostInput(params: {
  inputEventsWhileAway: number;
  domValue: string;
  expectedValue: string;
}): boolean {
  if (params.inputEventsWhileAway > 0) return false;
  return params.domValue !== params.expectedValue;
}
