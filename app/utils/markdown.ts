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
