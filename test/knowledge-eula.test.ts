import { chunkMarkdown } from "../app/utils/knowledge/chunker";

/**
 * EULA / 合同这类纯文本的切分行为。
 *
 * 它们没有任何 `#` 标题，只有 Setext 的 `---` 分隔线（正文下面的横线）。
 * 那条线是“正文分隔符”，**不是**章节标题，绝不能拿它切块，
 * 否则一份 EULA 会被切成几十个标题为内容的碎片。
 */
describe("EULA / 纯文本切分", () => {
  const eula = `
END USER LICENSE AGREEMENT

This Agreement is made between the Licensor and You.

---

1. GRANT OF LICENSE

Subject to the terms of this Agreement, Licensor grants You a
non-exclusive, non-transferable license.

---

2. RESTRICTIONS

You may not reverse engineer, decompile, or disassemble the Software.

---

3. TERMINATION

This Agreement is effective until terminated.
`.trim();

  test("没有任何 # 标题时，整篇作为一节", () => {
    const { sections, stats } = chunkMarkdown(eula);

    expect(sections).toHaveLength(1);
    expect(sections[0].heading).toBe("(前言)");
    expect(sections[0].text).toContain("END USER LICENSE AGREEMENT");
    expect(sections[0].text).toContain("3. TERMINATION");
    // 整篇内容都在，没有被 `---` 切开
    expect(stats.sections).toBe(1);
  });

  test("即使超过 maxChars 也不会用 --- 去切", () => {
    const long = eula + "\n\n" + "额外条款内容。".repeat(500);
    const { sections } = chunkMarkdown(long, { maxChars: 1000, minChars: 0 });

    expect(sections).toHaveLength(1);
    expect(sections[0].text).toContain("额外条款内容。");
  });

  test("有 # 标题时仍然正常按标题切", () => {
    const withHeadings = `
# 用户协议

## 1. 授权

内容一。

## 2. 限制

内容二。
`.trim();

    const { sections } = chunkMarkdown(withHeadings, { minChars: 0 });
    const headings = sections.map((section) => section.heading);
    expect(headings).toContain("1. 授权");
    expect(headings).toContain("2. 限制");
  });

  test("正文里单独一行 --- 不会被当成标题", () => {
    const mixed = `
# 协议

前言。

---

正文第一部分。

---

正文第二部分。
`.trim();

    const { sections } = chunkMarkdown(mixed, { minChars: 0 });
    // 只有「协议」一个标题，`---` 不产生新节
    expect(sections.filter((section) => section.level > 0)).toHaveLength(1);
    expect(sections[0].text).toContain("正文第二部分");
  });
});
