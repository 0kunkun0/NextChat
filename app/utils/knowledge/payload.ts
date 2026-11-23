import type { KnowledgeChunk } from "./retrieval";
import type { DocMeta } from "./store";

/**
 * 云端知识库 payload 的解析（纯函数，不碰 IndexedDB，方便单测）。
 *
 * 两种形态都要接受：
 *   - `upstash.download()` 读 store 时已经 `JSON.parse` 过 → **对象**
 *   - 直接读原始 key / 老数据 → **字符串**
 *
 * 早期实现只接受字符串，`remote["__knowledge__"]` 是对象时直接 return，
 * 表现就是「云端明明有知识库，下载后本地还是空的」。
 */

export type KnowledgePayload = {
  version: 1;
  exportedAt: number;
  docs: DocMeta[];
  chunks: KnowledgeChunk[];
};

/**
 * @param input JSON 字符串或已解析的对象
 * @returns 合法的 payload；结构不对时返回 null
 */
export function normalizeKnowledgePayload(
  input: unknown,
): KnowledgePayload | null {
  let parsed: unknown = input;

  if (typeof input === "string") {
    try {
      parsed = JSON.parse(input);
    } catch (e) {
      console.warn("[Knowledge] payload is not valid JSON", e);
      return null;
    }
  }

  if (!parsed || typeof parsed !== "object") return null;
  const payload = parsed as Partial<KnowledgePayload>;
  if (payload.version !== 1) return null;
  if (!Array.isArray(payload.docs)) return null;

  return {
    version: 1,
    exportedAt: Number(payload.exportedAt) || Date.now(),
    docs: payload.docs,
    chunks: Array.isArray(payload.chunks) ? payload.chunks : [],
  };
}
