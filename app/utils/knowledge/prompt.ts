/**
 * 「本轮该注入哪几节知识库」的选取逻辑（纯函数，便于测试）。
 *
 * 优先级（改这里之前先想清楚三者的关系）：
 *   1. 会话里**手动勾选了片段** → 就用它（用户在会话设置里改完，重新生成也要立刻生效）；
 *   2. 会话里**明确清空了勾选**（`sectionIds: []`）→ 按这条用户消息的内容重新检索；
 *   3. 从没配置过（`sectionIds` 为 undefined，老会话）→ 沿用消息上记录的片段 id。
 *
 * 以前只认第 3 条，所以「改完勾选再重新生成」永远用的是旧引用。
 */

type MessageLike = {
  role: string;
  content?: any;
  retrieval?: {
    sections?: Array<{ id?: string }>;
  } | null;
};

export type KnowledgeTarget =
  | { mode: "pinned"; ids: string[] }
  | { mode: "auto"; text: string }
  | { mode: "stored"; ids: string[] }
  | { mode: "none" };

/**
 * @param pinned 会话里勾选的片段 id；undefined 表示从没配置过
 * @param messages 本次请求要发送的消息（不含知识库那条 system）
 */
export function resolveKnowledgeTarget(input: {
  pinned?: string[];
  messages: MessageLike[];
}): KnowledgeTarget {
  const { pinned, messages } = input;

  if (pinned && pinned.length > 0) {
    return { mode: "pinned", ids: pinned };
  }

  if (pinned !== undefined) {
    // 明确清空选择：按问题重新检索
    const text = lastUserText(messages);
    return text ? { mode: "auto", text } : { mode: "none" };
  }

  const ids = pickKnowledgeSectionIds(messages);
  return ids.length > 0 ? { mode: "stored", ids } : { mode: "none" };
}

/**
 * 从后往前找最近一条带知识库引用的用户消息——也就是本轮要回答的那条。
 * 重新生成某条回复时，messages 已经被截到该条之前，所以同样取到正确的那条。
 */
export function pickKnowledgeSectionIds(messages: MessageLike[]): string[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "user") continue;
    const sections = message.retrieval?.sections ?? [];
    if (sections.length === 0) continue;

    const ids = sections
      .map((section) => section.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    if (ids.length === 0) continue;
    return ids;
  }
  return [];
}

/** 最近一条用户消息的纯文本（用于「清空勾选 → 按问题检索」） */
export function lastUserText(messages: MessageLike[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "user") continue;
    return textOf(message.content).trim();
  }
  return "";
}

/** 最近一条用户消息的 id（回写引用信息用） */
export function lastUserId(messages: MessageLike[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "user") return (message as any).id;
  }
  return undefined;
}

function textOf(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  for (const block of content) {
    if (block?.type === "text") return block.text ?? "";
  }
  return "";
}
