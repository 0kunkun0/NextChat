import { normalizeBlankLines } from "./format";

/**
 * 把裸的 `\[ ... \]` / `\( ... \)` 转成 markdown 数学公式语法 `$$...$$` / `$...$`。
 * 代码块 / 行内代码里的内容原样保留。
 */
export function escapeBrackets(text: string) {
  const pattern =
    /(```[\s\S]*?```|`.*?`)|\\\[([\s\S]*?[^\\])\\\]|\\\((.*?)\\\)/g;
  return text.replace(
    pattern,
    (match, codeBlock, squareBracket, roundBracket) => {
      if (codeBlock) {
        return codeBlock;
      } else if (squareBracket) {
        return `$$${squareBracket}$$`;
      } else if (roundBracket) {
        return `$${roundBracket}$`;
      }
      return match;
    },
  );
}

/**
 * 把没有 ``` 包裹的整段 HTML（`<!DOCTYPE html> ... </html>`）包进 html 代码块。
 */
export function tryWrapHtmlCode(text: string) {
  // try add wrap html code (fixed: html codeblock include 2 newline)
  // ignore embed codeblock
  if (text.includes("```")) {
    return text;
  }
  return text
    .replace(
      /([`]*?)(\w*?)([\n\r]*?)(<!DOCTYPE html>)/g,
      (match, quoteStart, lang, newLine, doctype) => {
        return !quoteStart ? "\n```html\n" + doctype : match;
      },
    )
    .replace(
      /(<\/body>)([\r\n\s]*?)(<\/html>)([\n\r]*)([`]*)([\n\r]*?)/g,
      (match, bodyEnd, space, htmlEnd, newLine, quoteEnd) => {
        return !quoteEnd ? bodyEnd + space + htmlEnd + "\n```\n" : match;
      },
    );
}

/**
 * 消息正文在交给 ReactMarkdown 之前会经过的全部预处理。
 * 调试窗口用它来展示“渲染器实际看到的字符串”。
 */
export function getMarkdownInput(content: string) {
  return tryWrapHtmlCode(escapeBrackets(normalizeBlankLines(content)));
}

type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
};

/**
 * `**xxx**`：内容里不能再有星号、首尾不能是空白，
 * 这样既不会把好几段粗体 greedy 地连成一串，也不会把 `a ** b` 当成粗体。
 */
const LITERAL_STRONG = /\*\*([^*\s](?:[^*\n]*[^*\s])?)\*\*/g;

function splitLiteralStrong(value: string): MarkdownNode[] | null {
  if (!value.includes("**")) return null;

  const parts: MarkdownNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  LITERAL_STRONG.lastIndex = 0;
  while ((match = LITERAL_STRONG.exec(value))) {
    if (match.index > lastIndex) {
      parts.push({ type: "text", value: value.slice(lastIndex, match.index) });
    }
    parts.push({
      type: "strong",
      children: [{ type: "text", value: match[1] }],
    });
    lastIndex = match.index + match[0].length;
  }

  if (parts.length === 0) return null;
  if (lastIndex < value.length) {
    parts.push({ type: "text", value: value.slice(lastIndex) });
  }
  return parts;
}

/**
 * 修复中文里 `**（xxx）**` 不显示粗体的问题。
 *
 * CommonMark 的 flanking 规则：`**` 后面紧跟「（、『「』」这类标点时，
 * 前面必须是空白或标点才算合法的开头。中文里常见 `这是**（重点）**内容`，
 * 星号前面是汉字 → 解析器不认为是粗体，页面上就直接露出两个星号。
 *
 * 这里在解析之后再补救一次：解析阶段已经变成 strong 的不会走到这里，
 * 仍然以字面量形式留在文本节点里的 `**xxx**` 才转成 strong。
 */
export function remarkFixLiteralStrong() {
  return (tree: MarkdownNode) => {
    const rewrite = (node: MarkdownNode) => {
      if (!Array.isArray(node.children)) return;

      const nextChildren: MarkdownNode[] = [];
      for (const child of node.children) {
        if (child.type === "text") {
          const parts = splitLiteralStrong(child.value ?? "");
          if (parts) {
            nextChildren.push(...parts);
            continue;
          }
        } else if (
          // 代码 / 公式里的星号是字面量，不能动
          child.type !== "inlineCode" &&
          child.type !== "code" &&
          child.type !== "math" &&
          child.type !== "inlineMath"
        ) {
          rewrite(child);
        }
        nextChildren.push(child);
      }
      node.children = nextChildren;
    };

    rewrite(tree);
  };
}
