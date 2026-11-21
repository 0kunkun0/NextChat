/**
 * 「本轮该注入哪几节知识库」的选取逻辑（纯函数，便于测试）。
 *
 * 规则：从后往前找最近一条**带知识库引用**的用户消息——也就是本轮要回答的那条。
 * 重新生成某条回复时，messages 已经被截到该条之前，所以这里同样取到正确的那条。
 */

type MessageLike = {
  role: string;
  retrieval?: {
    sections?: Array<{ id?: string }>;
  } | null;
};

/**
 * @param messages 当前请求要发送的消息（不含 system 知识库那条）
 * @returns 需要注入的片段 id（顺序保持消息里记录的顺序）
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
