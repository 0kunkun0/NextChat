import { shouldRestoreLostInput } from "../app/utils/input-recovery";

/**
 * iOS 15 的「翻译 / 查询」吞字：
 *   选中文字 → 系统菜单 → 内容少了，而且**一个 input 事件都没有**。
 *
 * 判据只看事件，不看长度——所以拼音选前半段候选词（内容会短暂变短，
 * 但一定有 input 事件）不会被误判。
 */
describe("shouldRestoreLostInput", () => {
  test("没有任何 input 事件 + DOM 和状态不一致 → 判定为被吞，需要恢复", () => {
    expect(
      shouldRestoreLostInput({
        inputEventsWhileAway: 0,
        domValue: "",
        expectedValue: "这是一段选中的文字",
      }),
    ).toBe(true);
  });

  test("期间有 input 事件（正常输入 / 拼音选词 / 自动更正）→ 不干预", () => {
    expect(
      shouldRestoreLostInput({
        inputEventsWhileAway: 3,
        domValue: "nihao",
        expectedValue: "你好",
      }),
    ).toBe(false);
  });

  test("DOM 和状态一致 → 什么都不做", () => {
    expect(
      shouldRestoreLostInput({
        inputEventsWhileAway: 0,
        domValue: "一致",
        expectedValue: "一致",
      }),
    ).toBe(false);
  });

  test("空输入框首次聚焦（都是空串）→ 不误报", () => {
    expect(
      shouldRestoreLostInput({
        inputEventsWhileAway: 0,
        domValue: "",
        expectedValue: "",
      }),
    ).toBe(false);
  });

  test("有事件但内容也被改短（用户真的在删）→ 不干预", () => {
    expect(
      shouldRestoreLostInput({
        inputEventsWhileAway: 1,
        domValue: "短",
        expectedValue: "很长的一段文字",
      }),
    ).toBe(false);
  });
});
