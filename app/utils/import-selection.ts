/**
 * 会话选择集合的纯逻辑。
 *
 * 抽出来的原因：勾选 / 全选的行为需要单测，而直接在组件里操作 Set
 * 很容易踩到 React 事件对象的坑（见下）。
 */

/**
 * 切换一个会话的勾选状态，返回新的 Set（不改原集合）。
 * @param selected 当前勾选的 exportId 集合
 * @param id 要切换的会话 id
 * @param checked 目标状态。**必须先由调用方从事件里取出**
 *  （`e.currentTarget.checked`），不能在 setState 的 updater 里读：
 *  React 在回调返回后会把 currentTarget 置空，updater 晚一步执行就会拿到 null。
 */
export function toggleSelected(
  selected: ReadonlySet<string>,
  id: string,
  checked: boolean,
): Set<string> {
  const next = new Set(selected);
  if (checked) next.add(id);
  else next.delete(id);
  return next;
}

/** 全选 / 取消全选 */
export function selectAll(
  ids: readonly string[],
  checked: boolean,
): Set<string> {
  return checked ? new Set(ids) : new Set<string>();
}

/** 当前是否全部勾选（空集合视为未全选） */
export function isAllSelected(
  selected: ReadonlySet<string>,
  total: number,
): boolean {
  return total > 0 && selected.size === total;
}
