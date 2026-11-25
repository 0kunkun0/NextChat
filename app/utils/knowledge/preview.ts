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

/** 关键字高亮：实现在 utils/text-highlight，这里转出方便知识库模块统一引用 */
export { highlightParts, type HighlightPart } from "../text-highlight";
