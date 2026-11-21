import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import {
  getMarkdownInput,
  protectInlineMarkers,
  remarkFixLiteralStrong,
  stripMarkdownSentinels,
} from "../app/utils/markdown";

/**
 * 行内标记配对。
 *
 * CommonMark 的 flanking 规则在中文标点前会失效：
 * `多个**（甲）**和**（乙）**都在` 里第一个 `**` 后面是「（」、前面是汉字，
 * 解析器不认它开头，反而把后面那个 `**` 当开头 → 渲染成
 * `多个**（甲）` + 粗体「和」+ `（乙）**都在`（也就是“匹配了最近的 **”）。
 *
 * 修法：解析前把成对标记换成哨兵，解析后还原。
 */
const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkFixLiteralStrong);

/** 收集渲染结果，方便断言 */
function collect(tree: any, out: string[] = []) {
  for (const node of tree.children ?? []) {
    if (node.type === "text") {
      out.push(`text:${node.value}`);
    } else if (node.type === "inlineCode" || node.type === "code") {
      out.push(`code:${node.value}`);
    } else if (node.type === "strong") {
      out.push(`strong:${textOf(node)}`);
    } else if (node.type === "emphasis") {
      out.push(`emph:${textOf(node)}`);
    } else if (node.type === "delete") {
      out.push(`del:${textOf(node)}`);
    } else {
      collect(node, out);
    }
  }
  return out;
}

function textOf(node: any): string {
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map(textOf).join("");
}

function render(markdown: string) {
  const input = getMarkdownInput(markdown);
  return collect(processor.runSync(processor.parse(input)));
}

describe("粗体配对（CJK 标点场景）", () => {
  test("两个括号粗体各自配对，不会错位", () => {
    expect(render("多个**（甲）**和**（乙）**都在")).toEqual([
      "text:多个",
      "strong:（甲）",
      "text:和",
      "strong:（乙）",
      "text:都在",
    ]);
  });

  test("行内夹一个括号粗体也能渲染", () => {
    expect(render("这是**（重点）**内容")).toEqual([
      "text:这是",
      "strong:（重点）",
      "text:内容",
    ]);
  });

  test("后面还有普通粗体时不会抢走前面的内容", () => {
    expect(render("**A**（说明）**B**")).toEqual([
      "strong:A",
      "text:（说明）",
      "strong:B",
    ]);
  });

  test("普通粗体不受影响", () => {
    expect(render("**重点**")).toEqual(["strong:重点"]);
  });

  test("未闭合的星号保持字面量", () => {
    expect(render("**未闭合")).toEqual(["text:**未闭合"]);
    expect(render("2 ** 3")).toEqual(["text:2 ** 3"]);
  });

  test("代码里的星号不动", () => {
    expect(render("`**not bold**`")).toEqual(["code:**not bold**"]);
    expect(render("```\n**代码里的**\n```")).toEqual(["code:**代码里的**"]);
  });

  test("真正的嵌套：粗体里套斜体", () => {
    // strong 内部不再展开收集，嵌套结构由下一个用例单独断言
    expect(render("**粗体里 *斜体* 结束**")).toEqual([
      "strong:粗体里 斜体 结束",
    ]);
  });

  test("粗体里的斜体单独收集时有内容", () => {
    const input = getMarkdownInput("**a *b* c**");
    const tree: any = processor.runSync(processor.parse(input));
    const strong = tree.children[0].children.find(
      (node: any) => node.type === "strong",
    );
    expect(strong.children.map((node: any) => node.type)).toEqual([
      "text",
      "emphasis",
      "text",
    ]);
  });
});

describe("斜体配对", () => {
  test("括号斜体可以渲染", () => {
    expect(render("这是*（重点）*内容")).toEqual([
      "text:这是",
      "emph:（重点）",
      "text:内容",
    ]);
  });

  test("多个斜体各自配对", () => {
    expect(render("一*甲*二*乙*三")).toEqual([
      "text:一",
      "emph:甲",
      "text:二",
      "emph:乙",
      "text:三",
    ]);
  });

  test("粗体里的星号不会被当成斜体开头", () => {
    expect(render("**粗体**")).toEqual(["strong:粗体"]);
  });
});

describe("删除线配对", () => {
  test("括号删除线可以渲染", () => {
    expect(render("删除~~（不要了）~~内容")).toEqual([
      "text:删除",
      "del:（不要了）",
      "text:内容",
    ]);
  });

  test("多个删除线各自配对", () => {
    expect(render("~~甲~~和~~乙~~")).toEqual(["del:甲", "text:和", "del:乙"]);
  });
});

describe("哨兵本身不该泄漏", () => {
  test("getMarkdownInput 的输出里不残留可见星号对", () => {
    const input = getMarkdownInput("多个**（甲）**和**（乙）**都在");
    expect(input).not.toContain("**");
    expect(stripMarkdownSentinels(input)).toBe("多个（甲）和（乙）都在");
  });

  test("protectInlineMarkers 不动代码块里的星号", () => {
    const input = protectInlineMarkers("```cpp\nint a = **b;\n```");
    expect(input).toContain("**b");
  });
});
