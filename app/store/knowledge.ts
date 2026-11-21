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
  search,
  type KnowledgeChunk,
  type KnowledgeIndex,
  type SearchHit,
} from "../utils/knowledge/retrieval";
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
};

export type SearchOptions = {
  budgetTokens?: number;
  candidates?: number;
  minChars?: number;
};

export type KnowledgeResult = {
  hits: SearchHit[];
  text: string;
  tokens: number;
  empty: boolean;
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
    if (!query.trim()) {
      return { hits: [], text: "", tokens: 0, empty: true };
    }
    if (get().indexSignature === "" || get().index === null) {
      await get().refresh();
    }
    const index = get().index;
    if (!index || index.chunks.length === 0) {
      return { hits: [], text: "", tokens: 0, empty: true };
    }

    const hits = search(index, query, options);
    return {
      hits,
      text: formatInjection(hits),
      tokens: hits.reduce((sum, hit) => sum + hit.estTokens, 0),
      empty: hits.length === 0,
    };
  },
}));

/** 供测试 / 调试：直接拿当前索引里的分块数 */
export function getIndexedChunkCount() {
  return cachedChunks.length;
}
