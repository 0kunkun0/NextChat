import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { remarkFixLiteralStrong } from "../app/utils/markdown";

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkFixLiteralStrong);

/** 收集渲染结果里所有 text / strong / inlineCode，方便断言 */
function collect(tree: any, out: string[] = []) {
  for (const node of tree.children ?? []) {
    if (node.type === "text") out.push(`text:${node.value}`);
    if (node.type === "inlineCode") out.push(`code:${node.value}`);
    if (node.type === "strong") {
      out.push(
        `strong:${(node.children ?? [])
          .map((c: any) => c.value ?? "")
          .join("")}`,
      );
      continue;
    }
    collect(node, out);
  }
  return out;
}

function render(text: string) {
  return collect(processor.runSync(processor.parse(text)));
}

describe("remarkFixLiteralStrong", () => {
  test("stars glued to Chinese text still become bold", () => {
    // CommonMark 认为 ** 前面是汉字、后面是「（」时不是合法的粗体开头
    expect(render("这是**（重点）**内容")).toEqual([
      "text:这是",
      "strong:（重点）",
      "text:内容",
    ]);
  });

  test("bold with punctuation inside works at line start", () => {
    expect(render("**（重点）**")).toEqual(["strong:（重点）"]);
  });

  test("normal markdown bold is untouched", () => {
    expect(render("**重点**")).toEqual(["strong:重点"]);
  });

  test("keeps literal stars that are not bold syntax", () => {
    expect(render("2 ** 3")).toEqual(["text:2 ** 3"]);
    expect(render("**未闭合")).toEqual(["text:**未闭合"]);
  });

  test("does not touch inline code", () => {
    expect(render("`**not bold**`")).toEqual(["code:**not bold**"]);
  });

  test("splits every literal bold segment in a text node", () => {
    // 直接给插件一段文本节点：解析器怎么配对不管，这里只验证拆分逻辑
    const tree: any = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [{ type: "text", value: "甲**（一）**丙**（二）**" }],
        },
      ],
    };

    remarkFixLiteralStrong()(tree);

    const nodes = tree.children[0].children;
    expect(nodes.map((n: any) => n.type)).toEqual([
      "text",
      "strong",
      "text",
      "strong",
    ]);
    expect(nodes[1].children[0].value).toBe("（一）");
    expect(nodes[3].children[0].value).toBe("（二）");
  });
});
