import {
  CONTEXT_PAGE_SIZE,
  getContextWindow,
} from "../app/utils/context-prompt";

// 注意：不要写死页大小，CONTEXT_PAGE_SIZE 是会调的
describe("getContextWindow", () => {
  test("renders everything when the list fits in one page", () => {
    expect(getContextWindow(0, CONTEXT_PAGE_SIZE)).toEqual({
      start: 0,
      visible: 0,
      hidden: 0,
      draggable: true,
    });
    expect(getContextWindow(CONTEXT_PAGE_SIZE, CONTEXT_PAGE_SIZE)).toEqual({
      start: 0,
      visible: CONTEXT_PAGE_SIZE,
      hidden: 0,
      draggable: true,
    });
  });

  test("keeps the most recent messages for long lists", () => {
    const total = CONTEXT_PAGE_SIZE * 5;
    const page = getContextWindow(total, CONTEXT_PAGE_SIZE);

    expect(page.start).toBe(total - CONTEXT_PAGE_SIZE);
    expect(page.visible).toBe(CONTEXT_PAGE_SIZE);
    expect(page.hidden).toBe(total - CONTEXT_PAGE_SIZE);
    // 没有全部渲染时不能开启拖拽（下标对不上）
    expect(page.draggable).toBe(false);
  });

  test("grows back towards the beginning as the page size increases", () => {
    const total = CONTEXT_PAGE_SIZE * 3;
    const page = getContextWindow(total, CONTEXT_PAGE_SIZE * 3);

    expect(page.start).toBe(0);
    expect(page.visible).toBe(total);
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
