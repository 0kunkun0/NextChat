import type { KnowledgeChunk } from "./retrieval";

/**
 * 片段列表里的正文预览。
 *
 * 文档标题经常是「概述」「常见用法」这类泛化词，光看标题选不准，
 * 所以选择弹窗每行都要带一段正文：去掉标题行、把代码围栏压成空格、
 * 空白折叠，最多 120 字。
 *
 * 搜索时如果关键字出现在正文里，预览会**从命中处开始**截一段，
 * 而不是永远显示开头——否则用户看不到为什么这节被搜出来了。
 */
export function previewOf(section: KnowledgeChunk, keyword = ""): string {
  const body = bodyOf(section);
  const needle = keyword.trim().toLowerCase();

  if (!needle) {
    return body.length > MAX_LENGTH ? `${body.slice(0, MAX_LENGTH)}…` : body;
  }

  const hitIndex = body.toLowerCase().indexOf(needle);
  if (hitIndex < 0) {
    return body.length > MAX_LENGTH ? `${body.slice(0, MAX_LENGTH)}…` : body;
  }

  // 命中点前面留一点上下文，后面把剩余窗口补齐
  const start = Math.max(0, hitIndex - CONTEXT_BEFORE);
  const end = Math.min(body.length, start + MAX_LENGTH);
  return `${start > 0 ? "…" : ""}${body.slice(start, end)}${
    end < body.length ? "…" : ""
  }`;
}

const MAX_LENGTH = 120;
const CONTEXT_BEFORE = 40;

function bodyOf(section: KnowledgeChunk): string {
  const body = section.text
    .split("\n")
    .slice(1)
    .join(" ")
    .replace(/```/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (body) return body;
  return section.text.replace(/\s+/g, " ").slice(0, MAX_LENGTH);
}

export type HighlightPart = { text: string; hit: boolean };

/**
 * 把文本按关键字切成「命中 / 未命中」片段，交给界面渲染成 `<mark>`。
 *
 * 用 indexOf 而不是正则：用户输入里的 `(`、`[`、`*` 之类不会炸正则，
 * 也不需要转义。
 *
 * @param text 原文
 * @param keyword 关键字（忽略大小写、忽略首尾空格）
 */
export function highlightParts(text: string, keyword = ""): HighlightPart[] {
  const needle = keyword.trim().toLowerCase();
  if (!needle || !text) return [{ text, hit: false }];

  const lower = text.toLowerCase();
  const parts: HighlightPart[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const index = lower.indexOf(needle, cursor);
    if (index < 0) {
      parts.push({ text: text.slice(cursor), hit: false });
      break;
    }
    if (index > cursor) {
      parts.push({ text: text.slice(cursor, index), hit: false });
    }
    parts.push({ text: text.slice(index, index + needle.length), hit: true });
    cursor = index + needle.length;
  }

  return parts.length > 0 ? parts : [{ text, hit: false }];
}
