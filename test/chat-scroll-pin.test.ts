import { shouldPinDuringStreaming } from "../app/utils/chat-scroll";

/**
 * 生成期间“往下滚会抽搐、卡在原地”的根因：
 * 钉顶逻辑每次渲染都会把 scrollTop 拉回气泡顶部，而旧代码只认「往上翻」，
 * 往下滚不会关闭钉顶，于是被反复拽回去。
 */
describe("shouldPinDuringStreaming", () => {
  const base = { autoScroll: true, manualBottom: false, userScrolled: false };

  test("默认状态（没被用户接管）→ 继续钉", () => {
    expect(shouldPinDuringStreaming(base)).toBe(true);
  });

  test("用户自己滚过（任意方向）→ 停止钉", () => {
    expect(shouldPinDuringStreaming({ ...base, userScrolled: true })).toBe(
      false,
    );
  });

  test("用户往上翻历史（autoScroll=false）→ 停止钉", () => {
    expect(shouldPinDuringStreaming({ ...base, autoScroll: false })).toBe(
      false,
    );
  });

  test("用户点了「回到底部」→ 停止钉", () => {
    expect(shouldPinDuringStreaming({ ...base, manualBottom: true })).toBe(
      false,
    );
  });

  test("多种接管同时存在也不钉", () => {
    expect(
      shouldPinDuringStreaming({
        autoScroll: false,
        manualBottom: true,
        userScrolled: true,
      }),
    ).toBe(false);
  });
});
