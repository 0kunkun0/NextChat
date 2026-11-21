import type { KnowledgeChunk } from "./retrieval";

/**
 * 片段列表里的正文预览。
 *
 * 文档标题经常是「概述」「常见用法」这类泛化词，光看标题选不准，
 * 所以选择弹窗每行都要带一段正文：去掉标题行、把代码围栏压成空格、
 * 空白折叠，最多 120 字。
 */
export function previewOf(section: KnowledgeChunk): string {
  const body = section.text
    .split("\n")
    .slice(1)
    .join(" ")
    .replace(/```/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!body) {
    return section.text.replace(/\s+/g, " ").slice(0, 120);
  }
  return body.length > 120 ? `${body.slice(0, 120)}…` : body;
}
