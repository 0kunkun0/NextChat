import {
  CONTEXT_PAGE_SIZE,
  getContextWindow,
} from "../app/utils/context-prompt";

describe("getContextWindow", () => {
  test("renders everything when the list is short", () => {
    expect(getContextWindow(0, CONTEXT_PAGE_SIZE)).toEqual({
      start: 0,
      visible: 0,
      hidden: 0,
      draggable: true,
    });
    expect(getContextWindow(12, CONTEXT_PAGE_SIZE)).toEqual({
      start: 0,
      visible: 12,
      hidden: 0,
      draggable: true,
    });
  });

  test("keeps the most recent messages for long lists", () => {
    const page = getContextWindow(500, CONTEXT_PAGE_SIZE);
    expect(page.start).toBe(500 - CONTEXT_PAGE_SIZE);
    expect(page.visible).toBe(CONTEXT_PAGE_SIZE);
    expect(page.hidden).toBe(500 - CONTEXT_PAGE_SIZE);
    // 没有全部渲染时不能开启拖拽（下标对不上）
    expect(page.draggable).toBe(false);
  });

  test("grows back towards the beginning as the page size increases", () => {
    const page = getContextWindow(100, CONTEXT_PAGE_SIZE * 3);
    expect(page.start).toBe(0);
    expect(page.visible).toBe(100);
    expect(page.draggable).toBe(true);
  });

  test("never exposes a negative or non-numeric range", () => {
    expect(getContextWindow(10, -5)).toEqual({
      start: 10,
      visible: 0,
      hidden: 10,
      draggable: false,
    });
    expect(getContextWindow(10, Number.NaN).visible).toBe(0);
    expect(getContextWindow(Number.NaN, 5).visible).toBe(0);
  });

  test("caps the page size at the message count", () => {
    const page = getContextWindow(30, CONTEXT_PAGE_SIZE * 10);
    expect(page.start).toBe(0);
    expect(page.visible).toBe(30);
  });
});
