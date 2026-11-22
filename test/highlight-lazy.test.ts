import {
  canHighlight,
  escapeHtml,
  highlightCode,
  isLanguageLoaded,
  loadLanguage,
  normalizeLanguage,
} from "../app/utils/highlight-lazy";

/**
 * 代码高亮按语言动态加载（替代 rehype-highlight 的全量打包）。
 */
describe("normalizeLanguage", () => {
  test("常见别名归一到 highlight.js 语言名", () => {
    expect(normalizeLanguage("c++")).toBe("cpp");
    expect(normalizeLanguage("C++")).toBe("cpp");
    expect(normalizeLanguage("cs")).toBe("csharp");
    expect(normalizeLanguage("c#")).toBe("csharp");
    expect(normalizeLanguage("sh")).toBe("bash");
    expect(normalizeLanguage("objc")).toBe("objectivec");
    expect(normalizeLanguage("html")).toBe("xml");
    expect(normalizeLanguage("yml")).toBe("yaml");
    expect(normalizeLanguage("ts")).toBe("typescript");
  });

  test("纯文本类语言按 plaintext 处理", () => {
    for (const name of ["", "text", "txt", "plaintext", "markdown", "latex"]) {
      expect(normalizeLanguage(name)).toBe("plaintext");
    }
    expect(normalizeLanguage(undefined)).toBe("plaintext");
  });

  test("未知语言退化成 plaintext（不报错）", () => {
    expect(normalizeLanguage("brainfuck")).toBe("plaintext");
    expect(canHighlight("brainfuck")).toBe(false);
  });

  test("带参数的语言标记也能识别", () => {
    expect(normalizeLanguage("cpp{linenos}")).toBe("cpp");
  });
});

describe("highlightCode", () => {
  test("语言包没加载时按纯文本渲染（含转义）", () => {
    const html = highlightCode("<div>a & b</div>", "cpp");
    expect(html).toBe("&lt;div&gt;a &amp; b&lt;/div&gt;");
  });

  test("plaintext 永远只做转义", () => {
    expect(highlightCode("a < b", "plaintext")).toBe("a &lt; b");
  });

  test("加载语言包之后会真正高亮", async () => {
    const ok = await loadLanguage("cpp");
    expect(ok).toBe(true);
    expect(isLanguageLoaded("cpp")).toBe(true);

    const html = highlightCode("int main() { return 0; }", "cpp");
    expect(html).toContain("hljs-");
  });

  test("重复加载不会重复注册（幂等）", async () => {
    expect(await loadLanguage("cpp")).toBe(true);
    expect(await loadLanguage("cpp")).toBe(true);
  });

  test("不支持的语言加载返回 false", async () => {
    expect(await loadLanguage("brainfuck")).toBe(false);
  });
});

describe("escapeHtml", () => {
  test("转义所有 HTML 敏感字符", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
    );
  });
});
