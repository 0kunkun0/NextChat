/**
 * 知识库检索的分词。
 *
 * 语料特点：中文说明 + 大量 C++/C#/Rust/Swift 示例代码。
 * 所以分两路：
 *   - 中文：2-gram（不引入分词库，中文检索够用）
 *   - 标识符 / 英文：整体 + 下划线/驼峰拆分，小写化
 *   - C++ 语法符号（(){};,*&<>）直接丢弃，避免噪声
 */

/** 代码里的常见关键字，作为搜索词没有区分度 */
const STOPWORDS = new Set([
  "void",
  "int",
  "const",
  "class",
  "struct",
  "enum",
  "using",
  "namespace",
  "return",
  "public",
  "private",
  "static",
  "auto",
  "bool",
  "char",
  "float",
  "double",
  "unsigned",
  "signed",
  "include",
  "define",
  "ifdef",
  "ifndef",
  "endif",
  "func",
  "let",
  "var",
  "pub",
  "fn",
  "impl",
  "mut",
  "self",
  "new",
  "std",
  "string",
  "str",
  "true",
  "false",
  "null",
  "nullptr",
  "the",
  "and",
  "for",
  "with",
  "from",
]);

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/**
 * 查询里的“无信息量”中文 bigram。
 *
 * 「XXX 是什么」「怎么用」这类问法如果把这些词也算进相关性，
 * 几乎每篇文档都会命中，真正的实体反而被稀释。只在**查询侧**过滤，
 * 索引侧保留（不影响文档自身的分词）。
 */
const CJK_STOP_BIGRAMS = new Set([
  "是什",
  "什么",
  "么是",
  "是怎",
  "怎么",
  "怎样",
  "么样",
  "如何",
  "为什",
  "哪些",
  "哪个",
  "是否",
  "可以",
  "应该",
  "需要",
  "一个",
  "这个",
  "那个",
  "请问",
  "告诉",
  "介绍",
  "一下",
  "有没",
  "没有",
  "我们",
  "你们",
  "他们",
  "多少",
  "的是",
  "是什",
  "是如",
  "么用",
  "用法是",
]);

/** 一段文本拆成 token（未去重、未计权重） */
export function tokenizeRaw(text: string): string[] {
  const tokens: string[] = [];
  if (!text) return tokens;

  // 按“非字母数字下划线”切开，CJK 单独成段
  const chunks = text.split(
    /[^0-9A-Za-z_\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/,
  );
  for (const chunk of chunks) {
    if (!chunk) continue;

    // 纯 CJK 段 → bigram（长度 1 时保留单字）
    if (!/[0-9A-Za-z_]/.test(chunk)) {
      if (chunk.length === 1) {
        tokens.push(chunk);
      } else {
        for (let i = 0; i + 1 < chunk.length; i++) {
          tokens.push(chunk.slice(i, i + 2));
        }
      }
      continue;
    }

    // 混合段：拆出 ASCII 标识符与 CJK 片段分别处理
    const parts =
      chunk.match(
        /[0-9A-Za-z_]+|[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g,
      ) ?? [];
    for (const part of parts) {
      if (CJK.test(part)) {
        if (part.length === 1) tokens.push(part);
        else {
          for (let i = 0; i + 1 < part.length; i++) {
            tokens.push(part.slice(i, i + 2));
          }
        }
        continue;
      }
      tokens.push(...splitIdentifier(part));
    }
  }

  return tokens;
}

/** 标识符 → 整体 + 下划线/驼峰拆分（全部小写） */
export function splitIdentifier(word: string): string[] {
  const out = new Set<string>();
  const lower = word.toLowerCase();
  if (lower.length >= 2) out.add(lower);

  // 去下划线
  if (word.includes("_")) {
    for (const piece of word.split("_")) {
      const p = piece.toLowerCase();
      if (p.length >= 2) out.add(p);
    }
  }

  // 驼峰：ClientConnect → client / connect
  const camel = word.match(/[A-Z]+[a-z0-9]*|[a-z0-9]+/g) ?? [];
  if (camel.length > 1) {
    for (const piece of camel) {
      const p = piece.toLowerCase();
      if (p.length >= 2) out.add(p);
    }
  }

  return [...out].filter((t) => !STOPWORDS.has(t));
}

/**
 * 只是虚词 / 语气词拼出来的 bigram，没有检索价值。
 *
 * 典型误伤：「怎么设置」切出的「么设」与「什么设计」的「么设」是同一个 bigram，
 * 于是问「怎么设置超时」会命中一段讲「为什么设计此文档」的正文。
 * 首字是「么 / 怎 / 的 / 是」的 bigram、尾字是「的 / 了 / 呢」的短词，查询侧直接丢掉。
 */
const NOISE_PREFIX = new Set("么怎的了吗呢吧啊呀是");
const NOISE_SUFFIX = new Set("的了吗呢吧啊呀哦");

function isNoiseBigram(token: string): boolean {
  if (token.length !== 2) return false;
  return NOISE_PREFIX.has(token[0]) || NOISE_SUFFIX.has(token[1]);
}

/** 查询串 → 去重后的 token 列表（滤掉通用中文 bigram 与代码关键字） */
export function tokenizeQuery(query: string): string[] {
  return [...new Set(tokenizeRaw(query))].filter(
    (t) => !STOPWORDS.has(t) && !CJK_STOP_BIGRAMS.has(t) && !isNoiseBigram(t),
  );
}

/** 判断一个 token 像不像代码标识符（用于精确命中加权） */
export function looksLikeIdentifier(token: string): boolean {
  return (
    /^[a-z0-9_]{3,}$/.test(token) ||
    /[_]/.test(token) ||
    /[a-z][A-Z]/.test(token)
  );
}

/**
 * 带权重的词频：代码围栏内的 token 权重 0.5（避免符号噪声压过正文）。
 * @param text 含代码块的 Markdown 片段
 */
export function termFrequencies(text: string): Map<string, number> {
  const weights = new Map<string, number>();
  const lines = text.split("\n");
  let inFence = false;
  let fenceChar = "";
  let fenceLen = 0;
  let prose = "";
  let code = "";

  for (const line of lines) {
    if (inFence) {
      const close = line.match(/^\s{0,3}(`{3,}|~{3,})\s*$/);
      code += line + "\n";
      if (close && close[1][0] === fenceChar && close[1].length >= fenceLen) {
        inFence = false;
      }
      continue;
    }
    const open = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (open) {
      fenceChar = open[1][0];
      fenceLen = open[1].length;
      inFence = true;
      code += line + "\n";
      continue;
    }
    prose += line + "\n";
  }

  const add = (source: string, weight: number) => {
    for (const token of tokenizeRaw(source)) {
      weights.set(token, (weights.get(token) ?? 0) + weight);
    }
  };

  add(prose, 1);
  add(code, 0.5);
  return weights;
}
