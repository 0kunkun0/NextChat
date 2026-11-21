import type { KnowledgeChunk } from "./retrieval";
import {
  listDocs,
  loadAllChunks,
  replaceAllFromSync,
  type DocMeta,
} from "./store";

/**
 * 知识库的云同步 payload。
 *
 * 走的是 Upstash 同步里「stores」那条通道：上传时作为额外 store 塞进索引，
 * 下载时原样取回来。这样能复用已有的增量哈希（没变就不重传）和分片写入。
 *
 * 体积参考：14 篇 md / 606 节 / 145 万字符 → JSON 约 1.5MB，
 * gzip + base64 后大概 400~600KB，在单 key 的安全读取上限内。
 */

/** 在同步索引里用的 key（不会和 StoreKey 冲突） */
export const KNOWLEDGE_SYNC_KEY = "__knowledge__";

export type KnowledgePayload = {
  version: 1;
  exportedAt: number;
  docs: DocMeta[];
  chunks: KnowledgeChunk[];
};

/**
 * 导出成同步用的 JSON 字符串。
 * 知识库为空时也返回一个空 payload（而不是 null），
 * 这样「清空知识库」这个动作也能同步出去，不会被云端旧数据复活。
 */
export async function exportKnowledgeJson(): Promise<string> {
  const docs = await listDocs();
  const chunks = docs.length > 0 ? await loadAllChunks() : [];
  const payload: KnowledgePayload = {
    version: 1,
    exportedAt: Date.now(),
    docs,
    chunks,
  };
  return JSON.stringify(payload);
}

/**
 * 用云端 payload 覆盖本地知识库。
 * @returns 导入了多少个文档 / 多少节
 */
export async function importKnowledgeJson(
  json: string,
): Promise<{ docs: number; chunks: number }> {
  const payload = JSON.parse(json) as KnowledgePayload;
  if (!payload || payload.version !== 1 || !Array.isArray(payload.docs)) {
    console.warn("[Knowledge] unsupported sync payload, skipped");
    return { docs: 0, chunks: 0 };
  }

  await replaceAllFromSync({
    docs: payload.docs,
    chunks: Array.isArray(payload.chunks) ? payload.chunks : [],
  });

  return { docs: payload.docs.length, chunks: payload.chunks?.length ?? 0 };
}
