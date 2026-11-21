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
  return protectInlineMarkers(
    tryWrapHtmlCode(escapeBrackets(normalizeBlankLines(content))),
  );
}

/* ------------------------------------------------------------------ *
 * 行内标记（粗体 / 斜体 / 删除线）的配对
 *
 * 问题：CommonMark 的 flanking 规则看的是标点/空白，中文里
 * `多个**（甲）**和**（乙）**都在` 这种写法，第一个 `**` 后面紧跟「（」
 * 且前面是汉字 → 不合法开头，解析器会**跳过它**，转而把后面那个 `**` 当开头，
 * 结果渲染成 `多个**（甲）` + 粗体「和」+ `（乙）**都在`——
 * 也就是“匹配了最近的 **”，正是要修的现象。
 *
 * 做法：解析前先把配对好的标记换成私有区哨兵字符（解析器只当普通文本），
 * 解析后再把哨兵还原成 strong / emphasis / delete 节点。
 * 配对规则就是最朴素的一条：**最早出现的未闭合标记作开头，匹配它后面最近的一个同类标记**。
 * ------------------------------------------------------------------ */

const SENTINEL = {
  strongOpen: "\uE000",
  strongClose: "\uE001",
  emphOpen: "\uE002",
  emphClose: "\uE003",
  delOpen: "\uE004",
  delClose: "\uE005",
} as const;

const ALL_SENTINELS = /[\uE000-\uE005]/g;

type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
};

/** 内容是否算“一个合法的强调区间”（不能为空、首尾不能是空白） */
function isValidRange(content: string): boolean {
  return content.length > 0 && !/^\s/.test(content) && !/\s$/.test(content);
}

/**
 * 把一段文本里成对的 marker 换成哨兵。
 * @param text 不含行内代码的片段
 * @param marker 标记字符（`**` / `~~` / `*`）
 * @param single 是否只认“单个星号”（斜体用，避免吃掉 `**` 的星号）
 */
function pairMarker(
  text: string,
  marker: string,
  open: string,
  close: string,
  single = false,
): string {
  let out = "";
  let i = 0;

  while (i < text.length) {
    if (!text.startsWith(marker, i)) {
      out += text[i];
      i += 1;
      continue;
    }

    if (single && (text[i - 1] === "*" || text[i + 1] === "*")) {
      // `**` 里的星号交给粗体那一轮处理
      out += marker;
      i += marker.length;
      continue;
    }

    const contentStart = i + marker.length;
    const closeIndex = findCloser(text, contentStart, marker);

    if (closeIndex < 0) {
      // 没有配对的标记：原样保留（`2 ** 3`、`**未闭合` 都不会变粗体）
      out += marker;
      i += marker.length;
      continue;
    }

    const content = text.slice(contentStart, closeIndex);
    if (!isValidRange(content)) {
      out += marker;
      i += marker.length;
      continue;
    }

    out += open + content + close;
    i = closeIndex + marker.length;
  }

  return out;
}

/** 从 start 开始找下一个能当结尾的 marker 下标 */
function findCloser(text: string, start: number, marker: string): number {
  let index = text.indexOf(marker, start);
  while (index >= 0) {
    const content = text.slice(start, index);
    if (isValidRange(content) && !content.includes("\n\n")) return index;
    index = text.indexOf(marker, index + marker.length);
  }
  return -1;
}

/** 处理一行里不含行内代码的片段：粗体 → 删除线 → 斜体 */
function pairInline(text: string): string {
  let out = pairMarker(text, "**", SENTINEL.strongOpen, SENTINEL.strongClose);
  out = pairMarker(out, "~~", SENTINEL.delOpen, SENTINEL.delClose);
  out = pairMarker(out, "*", SENTINEL.emphOpen, SENTINEL.emphClose, true);
  return out;
}

/**
 * 解析前的保护：把成对的行内标记换成哨兵。
 * 代码块 / 行内代码里的星号是字面量，必须跳过。
 */
export function protectInlineMarkers(markdown: string): string {
  const lines = markdown.split("\n");
  let fence: string | null = null;

  return lines
    .map((line) => {
      const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
      if (fenceMatch) {
        const char = fenceMatch[1][0];
        if (!fence) fence = char;
        else if (fence === char) fence = null;
        return line;
      }
      if (fence) return line;

      // 行内代码原样保留：按 `...` 切开，只处理非代码片段
      return line
        .split(/(`[^`]*`)/)
        .map((part, index) => (index % 2 === 1 ? part : pairInline(part)))
        .join("");
    })
    .join("\n");
}

/**
 * 把哨兵还原成真正的节点（strong / emphasis / delete）。
 *
 * 哨兵对在同一个文本节点里才能还原；跨节点的（比如中间夹了链接）就丢掉哨兵，
 * 至少不会把肉眼不可见的字符留在页面上。
 */
function restore(value: string): MarkdownNode[] {
  const nodes: MarkdownNode[] = [];
  let buffer = "";
  let i = 0;

  const flush = () => {
    if (buffer) {
      nodes.push({ type: "text", value: buffer });
      buffer = "";
    }
  };

  const wrapper: Record<string, { type: string; close: string }> = {
    [SENTINEL.strongOpen]: { type: "strong", close: SENTINEL.strongClose },
    [SENTINEL.emphOpen]: { type: "emphasis", close: SENTINEL.emphClose },
    [SENTINEL.delOpen]: { type: "delete", close: SENTINEL.delClose },
  };

  while (i < value.length) {
    const char = value[i];
    const spec = wrapper[char];

    if (!spec) {
      // 落单的结尾哨兵：直接丢掉，别让不可见字符露出来
      if (
        char === SENTINEL.strongClose ||
        char === SENTINEL.emphClose ||
        char === SENTINEL.delClose
      ) {
        i += 1;
        continue;
      }
      buffer += char;
      i += 1;
      continue;
    }

    const closeIndex = value.indexOf(spec.close, i + 1);
    if (closeIndex < 0) {
      i += 1;
      continue;
    }

    flush();
    nodes.push({
      type: spec.type,
      children: restore(value.slice(i + 1, closeIndex)),
    });
    i = closeIndex + 1;
  }

  flush();
  return nodes;
}

/**
 * 后处理插件：把哨兵还原成 strong / emphasis / delete。
 *
 * 同时兜底处理解析器留下的字面量 `**xxx**`（没被哨兵覆盖到的少数情况）。
 */
export function remarkFixLiteralStrong() {
  return (tree: MarkdownNode) => {
    const rewrite = (node: MarkdownNode) => {
      if (!Array.isArray(node.children)) return;

      const nextChildren: MarkdownNode[] = [];
      for (const child of node.children) {
        if (child.type === "text") {
          const restored = restore(child.value ?? "");
          if (restored.length > 0) {
            nextChildren.push(...restored);
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

/** 兜底：清掉可能残留的哨兵字符（导出文本、复制到剪贴板时用） */
export function stripMarkdownSentinels(text: string): string {
  return text.replace(ALL_SENTINELS, "");
}
