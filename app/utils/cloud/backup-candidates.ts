import type { ChatSession } from "../../store/chat";
import type { ImportedConversation } from "../deepseek-import";

/**
 * 「从数据库导入其它备份」里的纯逻辑：云端会话 → 勾选列表，以及重名处理。
 *
 * 单独放一个文件是为了不牵连 crypto-flow / 同步客户端这些重依赖，
 * 也让这部分逻辑可以直接单测。
 */

/**
 * 把云端会话转换成「导入会话选择」用的候选列表。
 * @param sessions 云端读出来的会话
 * @param localIds 本地已有 id（用来标记哪些会重名）
 */
export type RemoteImportCandidate = ImportedConversation & {
  /** 和本地已有会话 id 冲突（导入时会另存副本） */
  willRename?: boolean;
};

export function toImportCandidates(
  sessions: ChatSession[],
  localIds: string[] = [],
): RemoteImportCandidate[] {
  const local = new Set(localIds);
  return sessions
    .filter((session) => Array.isArray((session as any)?.messages))
    .map((session) => ({
      exportId: session.id,
      title: session.topic || "(无标题)",
      session,
      pinned: false,
      updatedAt: Number(session.lastUpdate) || 0,
      messageCount: session.messages.length,
      // 供界面提示「会新建副本」
      willRename: local.has(session.id),
    }))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

/**
 * 导入时给重名的会话换一个新 id，避免覆盖本地同名会话。
 * @param session 云端会话
 * @param taken 已占用的 id（会被就地更新）
 */
export function prepareSessionForImport<T extends ChatSession>(
  session: T,
  taken: Set<string>,
): { session: T; renamed: boolean } {
  if (!taken.has(session.id)) {
    taken.add(session.id);
    return { session, renamed: false };
  }

  const newId = `${session.id}-imported-${Date.now().toString(36)}`;
  taken.add(newId);
  return { session: { ...session, id: newId }, renamed: true };
}
