import {
  isAllSelected,
  selectAll,
  toggleSelected,
} from "../app/utils/import-selection";

/**
 * 这里守的是导入弹窗「勾选 / 取消全选」的核心逻辑。
 *
 * 之前的 bug 不在这些函数本身，而在调用方式：在 setState 的 updater 里读
 * `e.currentTarget.checked`（React 回调返回后 currentTarget 会被置空）。
 * 现在组件里先把 checked 取成局部变量再传进来，所以这里的入参是普通 boolean。
 */
describe("import-selection", () => {
  test("toggleSelected 返回新集合，不修改原集合", () => {
    const current = new Set(["a"]);
    const added = toggleSelected(current, "b", true);
    expect(added).toEqual(new Set(["a", "b"]));
    expect(current).toEqual(new Set(["a"])); // 原集合没变

    const removed = toggleSelected(added, "a", false);
    expect(removed).toEqual(new Set(["b"]));
    expect(added).toEqual(new Set(["a", "b"]));
  });

  test("重复勾选 / 重复取消都是幂等的", () => {
    const once = toggleSelected(new Set<string>(), "a", true);
    const twice = toggleSelected(once, "a", true);
    expect(twice).toEqual(new Set(["a"]));

    const cleared = toggleSelected(twice, "a", false);
    const again = toggleSelected(cleared, "a", false);
    expect(again).toEqual(new Set());
  });

  test("selectAll 全选 / 取消全选", () => {
    expect(selectAll(["a", "b", "c"], true)).toEqual(new Set(["a", "b", "c"]));
    expect(selectAll(["a", "b", "c"], false)).toEqual(new Set());
  });

  test("isAllSelected 的边界情况", () => {
    expect(isAllSelected(new Set(["a", "b"]), 2)).toBe(true);
    expect(isAllSelected(new Set(["a"]), 2)).toBe(false);
    // 没有候选项时不算全选（按钮应显示「全选」）
    expect(isAllSelected(new Set(), 0)).toBe(false);
  });
});
