import { create } from "zustand";

import {
  clearKnowledge,
  importDoc,
  listDocs,
  loadAllChunks,
  removeDoc,
  type DocMeta,
} from "../utils/knowledge/store";
import {
  buildIndex,
  formatInjection,
  pinnedHits,
  search,
  type KnowledgeChunk,
  type KnowledgeIndex,
  type SearchHit,
} from "../utils/knowledge/retrieval";
import { tokenizeQuery } from "../utils/knowledge/tokenize";
import { showToast } from "../components/ui-lib";
import Locale from "../locales";

/**
 * 知识库状态。
 *
 * 数据本身存在 IndexedDB（见 utils/knowledge/store），这里只放内存里的
 * 文档列表和检索索引；索引在文档变化后重建一次并缓存。
 */

type KnowledgeState = {
  docs: DocMeta[];
  loading: boolean;
  importing: boolean;
  /** 索引缓存 */
  index: KnowledgeIndex | null;
  /** 索引对应的文档签名，文档变动时失效 */
  indexSignature: string;
  refresh: () => Promise<void>;
  importFiles: (files: File[]) => Promise<{ imported: number; chunks: number }>;
  remove: (id: string) => Promise<void>;
  clear: () => Promise<void>;
  /** 检索并返回注入文本与命中详情 */
  retrieve: (
    query: string,
    options?: SearchOptions,
  ) => Promise<KnowledgeResult>;
  /** 只注入手动勾选的片段（不做检索） */
  retrievePinned: (
    sectionIds: string[],
    options?: SearchOptions,
  ) => Promise<KnowledgeResult>;
  /** 列出所有片段，供「选择知识库片段」弹窗使用 */
  listSections: () => Promise<KnowledgeChunk[]>;
};

export type SearchOptions = {
  budgetTokens?: number;
  candidates?: number;
  minChars?: number;
};

export type KnowledgeDebug = {
  /** 知识库里有多少文档 / 多少节 */
  docs: number;
  chunks: number;
  /** 查询被切成了哪些 token（排查“为什么没命中”） */
  queryTokens: string[];
  /** 为空的原因 */
  reason?: "empty-query" | "no-docs" | "no-match";
  /** 是否靠“去掉最小字数限制”的兜底才命中 */
  usedFallback?: boolean;
  /** 本次用的是手动勾选的片段还是自动检索 */
  mode?: "pinned" | "search";
  /** 手动勾选的片段里有几个已经不在库里（文档被删/换过） */
  missingPinned?: number;
};

export type KnowledgeResult = {
  hits: SearchHit[];
  text: string;
  tokens: number;
  empty: boolean;
  debug: KnowledgeDebug;
};

const signatureOf = (docs: DocMeta[]) =>
  docs.map((doc) => `${doc.id}:${doc.hash}`).join("|");

let cachedChunks: KnowledgeChunk[] = [];

export const useKnowledgeStore = create<KnowledgeState>((set, get) => ({
  docs: [],
  loading: false,
  importing: false,
  index: null,
  indexSignature: "",

  async refresh() {
    set({ loading: true });
    try {
      const docs = await listDocs();
      set({ docs });
      const signature = signatureOf(docs);
      if (signature !== get().indexSignature) {
        cachedChunks = docs.length > 0 ? await loadAllChunks() : [];
        set({
          index: buildIndex(cachedChunks),
          indexSignature: signature,
        });
      }
    } catch (e) {
      console.error("[Knowledge] refresh failed", e);
    } finally {
      set({ loading: false });
    }
  },

  async importFiles(files) {
    if (files.length === 0) return { imported: 0, chunks: 0 };
    set({ importing: true });
    let imported = 0;
    let chunks = 0;
    try {
      for (const file of files) {
        try {
          const content = await file.text();
          const { doc } = await importDoc(file.name, content);
          imported += 1;
          chunks += doc.chunks;
        } catch (e: any) {
          console.error("[Knowledge] import failed", file.name, e);
          showToast(
            Locale.Settings.Knowledge.ImportFailed(
              file.name,
              String(e?.message ?? e),
            ),
          );
        }
      }
      // 文档变了，索引必须重建
      set({ indexSignature: "" });
      await get().refresh();
      return { imported, chunks };
    } finally {
      set({ importing: false });
    }
  },

  async remove(id) {
    await removeDoc(id);
    set({ indexSignature: "" });
    await get().refresh();
  },

  async clear() {
    await clearKnowledge();
    cachedChunks = [];
    set({ index: null, indexSignature: "", docs: [] });
  },

  async retrieve(query, options = {}) {
    const tokens = tokenizeQuery(query);
    const emptyResult = (
      reason: KnowledgeDebug["reason"],
    ): KnowledgeResult => ({
      hits: [],
      text: "",
      tokens: 0,
      empty: true,
      debug: {
        docs: get().docs.length,
        chunks: get().index?.chunks.length ?? 0,
        queryTokens: tokens,
        reason,
      },
    });

    if (!query.trim()) return emptyResult("empty-query");

    if (get().indexSignature === "" || get().index === null) {
      await get().refresh();
    }
    const index = get().index;
    if (!index || index.chunks.length === 0) return emptyResult("no-docs");

    // 严格检索：丢弃小于 minChars 的节（只有标题没有正文的碎片）
    const strict = search(index, query, options);

    /**
     * 兜底：严格检索为空时，去掉 minChars 再来一次。
     *
     * 很多问答型文档的答案是几十个字的短节（比如 FAQ 的一问一答），
     * 按 200 字门槛会被直接过滤掉——用户看到的就是“没有检索到”。
     * 有内容就先用上，别让门槛把结果吞了。
     */
    const loose =
      strict.length === 0
        ? search(index, query, { ...options, minChars: 0, candidates: 8 })
        : [];

    const injected = strict.length > 0 ? strict : loose;
    const result: KnowledgeResult = {
      hits: injected,
      text: formatInjection(injected),
      tokens: injected.reduce((sum, hit) => sum + hit.estTokens, 0),
      empty: injected.length === 0,
      debug: {
        docs: get().docs.length,
        chunks: index.chunks.length,
        queryTokens: tokens,
        reason: injected.length > 0 ? undefined : "no-match",
        usedFallback: strict.length === 0 && loose.length > 0,
        mode: "search",
      },
    };

    if (result.empty) {
      console.warn("[Knowledge] no hit", {
        query,
        tokens: tokens.slice(0, 20),
        docs: result.debug.docs,
        chunks: result.debug.chunks,
      });
    } else if (result.debug.usedFallback) {
      console.info("[Knowledge] matched only after dropping minChars", {
        query,
        hits: injected.length,
      });
    }

    return result;
  },

  async retrievePinned(sectionIds, options = {}) {
    const tokens: string[] = [];
    const empty = (reason: KnowledgeDebug["reason"]): KnowledgeResult => ({
      hits: [],
      text: "",
      tokens: 0,
      empty: true,
      debug: {
        docs: get().docs.length,
        chunks: get().index?.chunks.length ?? 0,
        queryTokens: tokens,
        reason,
        mode: "pinned",
      },
    });

    if (sectionIds.length === 0) return empty("empty-query");

    if (get().indexSignature === "" || get().index === null) {
      await get().refresh();
    }
    const index = get().index;
    if (!index || index.chunks.length === 0) return empty("no-docs");

    const byId = new Map(index.chunks.map((chunk) => [chunk.id, chunk]));
    const picked = sectionIds
      .map((id) => byId.get(id))
      .filter((chunk): chunk is KnowledgeChunk => !!chunk);

    // 文档被删/重新导入后，旧 id 会失效——把缺口报出来，方便界面提示
    const missingPinned = sectionIds.length - picked.length;

    const chunksInOrder = picked.slice();
    const hits = pinnedHits(chunksInOrder, options);

    return {
      hits,
      text: formatInjection(hits),
      tokens: hits.reduce((sum, hit) => sum + hit.estTokens, 0),
      empty: hits.length === 0,
      debug: {
        docs: get().docs.length,
        chunks: index.chunks.length,
        queryTokens: tokens,
        reason: hits.length === 0 ? "no-match" : undefined,
        mode: "pinned",
        missingPinned,
      },
    };
  },

  async listSections() {
    if (get().indexSignature === "" || get().index === null) {
      await get().refresh();
    }
    return get().index?.chunks ?? [];
  },
}));

/** 供测试 / 调试：直接拿当前索引里的分块数 */
export function getIndexedChunkCount() {
  return cachedChunks.length;
}
