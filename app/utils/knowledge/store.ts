import { createStore, del, get, set } from "idb-keyval";

import { chunkMarkdown, type ChunkStats } from "./chunker";
import type { KnowledgeChunk } from "./retrieval";

/**
 * 知识库的本地存储（IndexedDB，不参与云同步）。
 *
 * 结构：
 *   - `knowledge:docs`        → { docs: DocMeta[] }
 *   - `knowledge:doc:<id>`    → { doc: DocMeta, chunks: KnowledgeChunk[] }
 *
 * 一个文档一条记录（最大的文档约 46 万字符），读出来就是完整的检索单元。
 */

const DB_NAME = "nextchat-knowledge";
const STORE_NAME = "knowledge";
const DOCS_KEY = "knowledge:docs";
const docKey = (id: string) => `knowledge:doc:${id}`;

const store = createStore(DB_NAME, STORE_NAME);

export type DocMeta = {
  id: string;
  name: string;
  /** 内容哈希，用于去重（同一个文件重复导入只更新） */
  hash: string;
  chars: number;
  chunks: number;
  importedAt: number;
};

type DocRecord = { doc: DocMeta; chunks: KnowledgeChunk[] };

/** 简单稳定的字符串哈希（用于文件去重） */
export function hashText(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = (h1 ^ code) * 0x01000193;
    h2 = (h2 + code * (i + 1)) >>> 0;
  }
  return `${(h1 >>> 0).toString(16)}${h2.toString(16)}`;
}

function makeDocId(name: string, hash: string) {
  const base = name.replace(/[^\w.-]+/g, "-").slice(0, 40);
  return `${base || "doc"}-${hash.slice(0, 8)}`;
}

/** 列出所有已导入的文档 */
export async function listDocs(): Promise<DocMeta[]> {
  const record = (await get<{ docs: DocMeta[] }>(DOCS_KEY, store)) ?? {
    docs: [],
  };
  return record.docs ?? [];
}

/** 读取所有分块（检索前调用） */
export async function loadAllChunks(): Promise<KnowledgeChunk[]> {
  const docs = await listDocs();
  const all: KnowledgeChunk[] = [];
  for (const doc of docs) {
    const record = await get<DocRecord>(docKey(doc.id), store);
    if (record?.chunks) all.push(...record.chunks);
  }
  return all;
}

/** 导入一个 Markdown 文档；同名同内容会覆盖 */
export async function importDoc(
  name: string,
  content: string,
  options: { level?: number; minChars?: number; maxChars?: number } = {},
): Promise<{ doc: DocMeta; stats: ChunkStats }> {
  const hash = hashText(content);
  const id = makeDocId(name, hash);

  const { sections, stats } = chunkMarkdown(content, options);
  const chunks: KnowledgeChunk[] = sections.map((section, index) => ({
    ...section,
    id: `${id}-${index}`,
    docId: id,
    docName: name,
  }));

  const doc: DocMeta = {
    id,
    name,
    hash,
    chars: stats.chars,
    chunks: chunks.length,
    importedAt: Date.now(),
  };

  await set(docKey(id), { doc, chunks } satisfies DocRecord, store);

  const docs = await listDocs();
  const next = docs.filter((item) => item.id !== id);
  next.push(doc);
  next.sort((a, b) => a.importedAt - b.importedAt);
  await set(DOCS_KEY, { docs: next }, store);

  return { doc, stats };
}

/** 删除一个文档 */
export async function removeDoc(id: string): Promise<void> {
  await del(docKey(id), store);
  const docs = await listDocs();
  await set(DOCS_KEY, { docs: docs.filter((item) => item.id !== id) }, store);
}

/** 清空整个知识库 */
export async function clearKnowledge(): Promise<void> {
  const docs = await listDocs();
  for (const doc of docs) {
    await del(docKey(doc.id), store);
  }
  await set(DOCS_KEY, { docs: [] }, store);
}
