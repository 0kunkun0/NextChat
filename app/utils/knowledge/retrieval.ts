/**
 * 知识库检索：BM25 + 标题/标识符加权 + 按预算装填。
 *
 * 参数依据实测语料（14 个 md，约 145 万字符、732 节、966 个代码块）：
 *   - 代码占 67% → 代码 token 权重 0.5，正文 1.0
 *   - 节大小两极分化（p90 10.8k 字、最大 87.5k 字）→ 不固定 top-k，
 *     先取 top-8 再按 token 预算装填
 *   - 有很多只有标题的空节（8~118 字）→ 小于 minChars 的直接丢弃
 */

import { truncateSectionSafe, type MarkdownSection } from "./chunker";
import {
  looksLikeIdentifier,
  termFrequencies,
  tokenizeQuery,
} from "./tokenize";

export type KnowledgeChunk = MarkdownSection & {
  /** 稳定 id：docId + 序号 */
  id: string;
  docId: string;
  docName: string;
};

export type SearchOptions = {
  /** 注入的 token 总预算 */
  budgetTokens?: number;
  /** 召回候选数量（装填前） */
  candidates?: number;
  /** 小于这个字数的节直接丢弃 */
  minChars?: number;
  /** 单节最多占多少 token（超过就按围栏边界截断） */
  maxSectionTokens?: number;
};

export type SearchHit = {
  chunk: KnowledgeChunk;
  score: number;
  text: string;
  estTokens: number;
  truncated: boolean;
};

export type KnowledgeIndex = {
  chunks: KnowledgeChunk[];
  /** term → (chunkIndex → 加权词频) */
  postings: Map<string, Map<number, number>>;
  /** 每节加权长度 */
  lengths: number[];
  avgLength: number;
};

const DEFAULT_OPTIONS: Required<SearchOptions> = {
  budgetTokens: 40000,
  candidates: 8,
  minChars: 200,
  maxSectionTokens: 40000,
};

const K1 = 1.2;
const B = 0.75;

/** 构建内存索引（几百到几千节，毫秒级） */
export function buildIndex(chunks: KnowledgeChunk[]): KnowledgeIndex {
  const postings = new Map<string, Map<number, number>>();
  const lengths: number[] = new Array(chunks.length).fill(0);

  chunks.forEach((chunk, index) => {
    const tf = termFrequencies(`${chunk.headingPath}\n${chunk.text}`);
    let length = 0;
    for (const [term, weight] of tf) {
      length += weight;
      let list = postings.get(term);
      if (!list) {
        list = new Map();
        postings.set(term, list);
      }
      list.set(index, weight);
    }
    lengths[index] = length;
  });

  const total = lengths.reduce((sum, n) => sum + n, 0);

  return {
    chunks,
    postings,
    lengths,
    avgLength: chunks.length ? total / chunks.length : 0,
  };
}

/** BM25 单节打分 */
function scoreChunk(
  index: KnowledgeIndex,
  chunkIndex: number,
  queryTokens: string[],
  identifiers: string[],
): number {
  const chunk = index.chunks[chunkIndex];
  let score = 0;
  const docLength = index.lengths[chunkIndex] || 1;
  const totalDocs = index.chunks.length;

  for (const token of queryTokens) {
    const list = index.postings.get(token);
    if (!list) continue;
    const tf = list.get(chunkIndex) ?? 0;
    if (!tf) continue;

    const df = list.size;
    const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));
    const norm = 1 - B + (B * docLength) / (index.avgLength || 1);
    score += idf * ((tf * (K1 + 1)) / (tf + K1 * norm));
  }

  // 标题命中加权
  const headingLower = `${chunk.headingPath} ${chunk.docName}`.toLowerCase();
  const matched = queryTokens.filter((token) => headingLower.includes(token));
  if (matched.length > 0) {
    score += Math.min(3, matched.length) * 0.8;
  }

  // 标识符精确命中（区分大小写，避免误伤）
  if (identifiers.length > 0) {
    const haystack = chunk.text;
    const hits = identifiers.filter((id) => haystack.includes(id));
    if (hits.length > 0) score += Math.min(3, hits.length) * 2;
  }

  return score;
}

/**
 * 检索并按预算装填。
 * @param index 索引
 * @param query 用户输入（可带最近一轮对话）
 * @param options 预算与候选数
 */
export function search(
  index: KnowledgeIndex,
  query: string,
  options: SearchOptions = {},
): SearchHit[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const queryTokens = tokenizeQuery(query);
  if (queryTokens.length === 0) return [];

  // 原始查询里的标识符（区分大小写），用于精确命中
  const identifiers = [
    ...new Set(
      (query.match(/[A-Za-z_][A-Za-z0-9_:]{2,}/g) ?? []).filter((id) =>
        looksLikeIdentifier(id),
      ),
    ),
  ];

  const scored: Array<{ chunkIndex: number; score: number }> = [];
  for (let i = 0; i < index.chunks.length; i++) {
    const chunk = index.chunks[i];
    if (chunk.chars < opts.minChars) continue;
    const score = scoreChunk(index, i, queryTokens, identifiers);
    if (score > 0) scored.push({ chunkIndex: i, score });
  }

  scored.sort((a, b) => b.score - a.score);

  // 按预算装填：依次纳入候选，直到超预算
  const hits: SearchHit[] = [];
  let used = 0;
  for (const candidate of scored.slice(0, opts.candidates)) {
    const chunk = index.chunks[candidate.chunkIndex];
    const maxForSection = Math.min(
      opts.maxSectionTokens,
      Math.max(1000, opts.budgetTokens - used),
    );
    const { text, truncated } = truncateSectionSafe(chunk, maxForSection);
    const estTokens = truncated ? maxForSection : chunk.estTokens;

    if (used + estTokens > opts.budgetTokens && hits.length > 0) break;

    hits.push({
      chunk,
      score: candidate.score,
      text,
      estTokens,
      truncated,
    });
    used += estTokens;
    if (used >= opts.budgetTokens) break;
  }

  return hits;
}

/**
 * 把检索结果拼成注入给模型的 Markdown 片段。
 * @param hits 检索结果
 */
export function formatInjection(hits: SearchHit[]): string {
  if (hits.length === 0) return "";

  const lines: string[] = [
    "以下是从本地知识库检索到的资料片段，可能不完整。",
    "回答时优先依据这些资料；资料没有覆盖的部分请如实说明。",
    "",
  ];

  hits.forEach((hit, index) => {
    lines.push(
      `### [${index + 1}] ${hit.chunk.headingPath || hit.chunk.heading}`,
      `（来源：${hit.chunk.docName}${
        hit.truncated ? "，本节过长已按代码块边界截断" : ""
      }）`,
      "",
      hit.text.trim(),
      "",
    );
  });

  lines.push("---", "");
  return lines.join("\n");
}
