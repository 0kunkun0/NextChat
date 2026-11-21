import {
  chunkMarkdown,
  truncateSectionSafe,
} from "../app/utils/knowledge/chunker";
import {
  termFrequencies,
  tokenizeQuery,
} from "../app/utils/knowledge/tokenize";
import {
  buildIndex,
  formatInjection,
  search,
  type KnowledgeChunk,
} from "../app/utils/knowledge/retrieval";

/**
 * 知识库切分 + 检索的回归测试。
 *
 * 语料特点（实测 14 个 md）：中文说明 + 大量 C++ 示例代码，
 * 代码占 67%，节大小两极分化（p90 10.8k 字、最大 87.5k 字）。
 */
function md(text: string) {
  return text.trim() + "\n";
}

describe("chunkMarkdown", () => {
  test("按 H3 切分，代码围栏里的 # 不算标题", () => {
    const { sections, stats } = chunkMarkdown(
      md(`
# 库文档

## 模块 mod0

### 连接

\`\`\`cpp
// # 这不是标题
namespace mylib::mod0 { void Connect(); }
\`\`\`

### 超时

说明文字。
`),
      { minChars: 0 },
    );

    const headings = sections.map((section) => section.heading);
    expect(headings).toContain("连接");
    expect(headings).toContain("超时");
    expect(headings).not.toContain("# 这不是标题");
    expect(stats.codeBlocks).toBe(1);
    // 切点不能落在代码块里
    expect(stats.unclosedFences).toBe(0);
  });

  test("小节合并：只有标题的节并入下一节", () => {
    const { sections } = chunkMarkdown(
      md(`
## 模块 A

### 空标题

### 有内容

这里是正文，写得长一点让它不算小节。${"填充".repeat(120)}
`),
      { minChars: 200 },
    );

    // 「空标题」被合并掉，只剩「有内容」那节（以及可能的模块 A）
    const hasEmpty = sections.some(
      (section) => section.heading === "空标题" && section.chars < 200,
    );
    expect(hasEmpty).toBe(false);
  });

  test("超长节用更深标题再切；没有更深标题则保留整段", () => {
    const body = "正文内容".repeat(300); // ~1200 字
    const { sections } = chunkMarkdown(
      md(`
## 大节 A

${body}

### 子节 A1

${body}

### 子节 A2

${body}

## 大节 B

${body}
`),
      { level: 2, maxChars: 1500, minChars: 0 },
    );

    // 大节 A 被 H3 切成子节
    expect(sections.some((section) => section.heading === "子节 A1")).toBe(
      true,
    );
    // 大节 B 没有更深标题，整段保留（可能超过上限）
    const bigB = sections.find((section) => section.heading === "大节 B");
    expect(bigB).toBeTruthy();
  });

  test("统计代码与正文字数比例", () => {
    const { stats, sections } = chunkMarkdown(
      md(`
### 例子

文字说明。

\`\`\`cpp
int main() { return 0; }
\`\`\`
`),
    );
    expect(stats.codeChars).toBeGreaterThan(0);
    expect(stats.chars).toBeGreaterThan(stats.codeChars);
    expect(sections[0].estTokens).toBeGreaterThan(0);
  });
});

describe("tokenize", () => {
  test("中文走 bigram，代码走标识符拆分", () => {
    const tokens = tokenizeQuery("Client::SetTimeout 怎么设置连接超时");
    expect(tokens).toContain("client");
    expect(tokens).toContain("settimeout");
    expect(tokens).toContain("set");
    expect(tokens).toContain("timeout");
    expect(tokens).toContain("连接");
    expect(tokens).toContain("超时");
    // 语法符号不应进入 token
    expect(tokens.some((token) => /[():;{}]/.test(token))).toBe(false);
  });

  test("代码块内 token 权重低于正文", () => {
    const tf = termFrequencies(
      "连接超时\n\n```cpp\nint connect_timeout = 1;\n```\n",
    );
    const prose = tf.get("连接") ?? 0;
    const code = tf.get("connect") ?? 0;
    expect(prose).toBeGreaterThan(code);
  });
});

describe("search + formatInjection", () => {
  function makeChunks(): KnowledgeChunk[] {
    const docs: Array<{ name: string; text: string }> = [
      {
        name: "network.md",
        text: md(`
## 连接

Client::Connect 用于建立连接，超时用 SetTimeout 设置。

\`\`\`cpp
Result Client::Connect(const std::string& host);
\`\`\`
`),
      },
      {
        name: "file.md",
        text: md(`
## 文件上传

Files API 上传文件后得到 file_id，删除用 DELETE /files/{id}。
`),
      },
      {
        name: "tiny.md",
        text: md(`
## 空节
`),
      },
    ];

    const chunks: KnowledgeChunk[] = [];
    for (const doc of docs) {
      const { sections } = chunkMarkdown(doc.text, { minChars: 0 });
      sections.forEach((section, index) => {
        chunks.push({
          ...section,
          id: `${doc.name}-${index}`,
          docId: doc.name,
          docName: doc.name,
        });
      });
    }
    return chunks;
  }

  test("能按标识符命中对应章节", () => {
    const index = buildIndex(makeChunks());
    const hits = search(index, "Client::Connect 怎么用", { minChars: 0 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].chunk.docName).toBe("network.md");
  });

  test("能按中文描述命中（不要求大小写一致）", () => {
    const index = buildIndex(makeChunks());
    const hits = search(index, "上传文件后怎么删除", { minChars: 0 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].chunk.docName).toBe("file.md");
  });

  test("小于 minChars 的节被丢弃", () => {
    const index = buildIndex(makeChunks());
    const hits = search(index, "空节", { minChars: 200 });
    expect(hits.some((hit) => hit.chunk.docName === "tiny.md")).toBe(false);
  });

  test("注入文本带标题路径与来源，且以分隔线结尾", () => {
    const index = buildIndex(makeChunks());
    const hits = search(index, "Client::Connect", { minChars: 0 });
    const text = formatInjection(hits);
    expect(text).toContain("### [1]");
    expect(text).toContain("来源：network.md");
    expect(text.trimEnd().endsWith("---")).toBe(true);
  });

  test("没有命中时注入为空", () => {
    const index = buildIndex(makeChunks());
    expect(formatInjection([])).toBe("");
  });
});

describe("truncateSectionSafe", () => {
  test("超预算时在代码围栏边界截断，不切进代码块", () => {
    const { sections } = chunkMarkdown(
      md(`
### 长节

${"正文".repeat(500)}

\`\`\`cpp
int a = 1;
\`\`\`

${"后续".repeat(500)}
`),
      { minChars: 0 },
    );

    const section = sections[0];
    const { text, truncated } = truncateSectionSafe(section, 50);
    expect(truncated).toBe(true);
    // 围栏必须成对出现（不能只留一个 ```）
    const fences = (text.match(/^\s*\`\`\`/gm) ?? []).length;
    expect(fences % 2).toBe(0);
  });

  test("预算足够时原样返回", () => {
    const { sections } = chunkMarkdown(md("### 小\n\n内容"), { minChars: 0 });
    const result = truncateSectionSafe(sections[0], 10_000);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe(sections[0].text);
  });
});

describe("排序改进：通用词与巨型章节", () => {
  function chunksFrom(docs: Array<{ name: string; text: string }>) {
    const chunks: KnowledgeChunk[] = [];
    for (const doc of docs) {
      const { sections } = chunkMarkdown(doc.text, { minChars: 0 });
      sections.forEach((section, index) => {
        chunks.push({
          ...section,
          id: `${doc.name}-${index}`,
          docId: doc.name,
          docName: doc.name,
        });
      });
    }
    return chunks;
  }

  test("「XXX 是什么」里的通用 bigram 不参与检索", () => {
    expect(tokenizeQuery("ikun.net 是什么")).toEqual(["ikun", "net"]);
    expect(tokenizeQuery("怎么使用 ikun")).not.toContain("怎么");
  });

  test("相关的小章节排在巨型章节前面", () => {
    // 巨型章节：1 万字大杂烩里只顺带提了一次 ikun.net
    const filler = "无关正文。".repeat(2000);
    const chunks = chunksFrom([
      {
        name: "big.md",
        text: md(`
## 大杂烩

${filler}

顺带提一句 ikun.net 也在里面。
`),
      },
      {
        name: "small.md",
        text: md(`
## ikun.net 是什么

ikun.net 是 C# 互操作层，提供托管调用入口。
`),
      },
    ]);

    const index = buildIndex(chunks);
    const hits = search(index, "ikun.net 是什么", { minChars: 0 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].chunk.docName).toBe("small.md");
  });
  test("和最高分差距过大的“陪跑”结果会被丢掉", () => {
    const chunks = chunksFrom([
      {
        name: "hit.md",
        text: md(`
## 超时设置

SetTimeout 用于设置连接超时，单位毫秒。
`),
      },
      {
        name: "noise.md",
        text: md(`
## 其它

${"全是无关内容。".repeat(800)}

末尾顺带提一次超时。
`),
      },
    ]);

    const index = buildIndex(chunks);
    const hits = search(index, "超时怎么设置", { minChars: 0 });
    expect(hits.length).toBeGreaterThan(0);
    // 只有真正相关的那个留下
    expect(hits.every((hit) => hit.chunk.docName === "hit.md")).toBe(true);
  });
});
