import { render } from "@testing-library/react";
import { jest } from "@jest/globals";
import React from "react";

/**
 * 流式输出时「横向列表拖不动」的根因回归。
 *
 * react-markdown 的 `components` 里如果写内联箭头函数，每次渲染都是新的
 * 函数引用 → React 认为「组件类型变了」→ 整棵子树卸载重挂 →
 * 表格 / 代码块的 scrollLeft 被重置到 0，看起来就是怎么拖都会弹回去。
 *
 * 说明：markdown.tsx 会顺带拉起 artifacts → home（home 是 CJS，
 * 在 ESM 测试环境里 `require` 不可用），所以这里 mock 掉 artifacts。
 */
jest.unstable_mockModule("@/app/components/artifacts", () => ({
  ArtifactsShareButton: () => null,
  HTMLPreview: () => null,
  HTMLPreviewHandler: () => null,
}));

const { Markdown } = await import("../app/components/markdown");

describe("Markdown 组件稳定性", () => {
  const table = [
    "| 列1 | 列2 | 列3 |",
    "| --- | --- | --- |",
    "| 1 | 2 | 3 |",
  ].join("\n");

  test("追加内容不会重挂表格容器（横向滚动位置保留）", () => {
    const { container, rerender } = render(<Markdown content={table} />);

    const wrapper = container.querySelector(".markdown-table-wrapper");
    expect(wrapper).toBeTruthy();
    // 模拟用户把表格横向拖到 40px
    (wrapper as HTMLElement).scrollLeft = 40;

    // 流式追加内容
    rerender(<Markdown content={`${table}\n\n更多文字`} />);

    // 同一个 DOM 节点（没有被卸载重挂）
    expect(container.querySelector(".markdown-table-wrapper")).toBe(wrapper);
    expect((wrapper as HTMLElement).scrollLeft).toBe(40);
  });

  test("追加内容不会重挂代码块", () => {
    const code = ["```js", "const a = 1;", "```"].join("\n");
    const { container, rerender } = render(<Markdown content={code} />);

    const pre = container.querySelector("pre");
    expect(pre).toBeTruthy();
    (pre as HTMLElement).scrollLeft = 12;

    rerender(<Markdown content={`${code}\n\n尾部说明`} />);

    expect(container.querySelector("pre")).toBe(pre);
    expect((pre as HTMLElement).scrollLeft).toBe(12);
  });

  test("段落节点也保持稳定", () => {
    const { container, rerender } = render(<Markdown content={"第一段"} />);
    const p = container.querySelector("p");
    expect(p).toBeTruthy();

    rerender(<Markdown content={"第一段，继续输出"} />);
    expect(container.querySelector("p")).toBe(p);
  });
});
