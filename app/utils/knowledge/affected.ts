/**
 * 删除知识库文档时，找出「哪些对话引用过它」并清掉失效的引用。
 *
 * 片段 id 的形态是 `<docId>-<序号>`（见 utils/knowledge/store.ts）。
 * 文档名里可能带 `-`，所以不能简单按 `-` 切分，而是用「前缀 + 纯数字后缀」判断归属。
 */

type RetrievalSection = {
  id?: string;
  headingPath: string;
  docName: string;
  chars: number;
};

type MessageLike = {
  retrieval?: { sections: RetrievalSection[]; tokens: number } | null;
};

type SessionLike = {
  id: string;
  topic?: string;
  messages: MessageLike[];
  knowledge?: { sectionIds?: string[] } | null;
};

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 这个片段 id 是否属于某个文档。
 * @param sectionId `<docId>-<序号>`
 * @param docId 文档 id
 */
export function sectionBelongsToDoc(sectionId: string, docId: string): boolean {
  if (!sectionId || !docId) return false;
  return new RegExp(`^${escapeRegExp(docId)}-\\d+$`).test(sectionId);
}

/** 一条消息里引用了哪些文档（去重） */
function docsOfMessage(message: MessageLike): string[] {
  const sections = message.retrieval?.sections ?? [];
  const ids = new Set<string>();
  for (const section of sections) {
    const id = section?.id;
    if (!id) continue;
    // `<docId>-<序号>`：从尾部剥掉 digits 就是 docId
    const match = id.match(/^(.*)-\d+$/);
    if (match) ids.add(match[1]);
  }
  return [...ids];
}

/**
 * 找出引用了这些文档的会话。
 * @param sessions 全部会话
 * @param docIds 要删除的文档 id
 * @returns 受影响的会话（含引用条数），按引用数倒序
 */
export function findAffectedSessions(
  sessions: SessionLike[],
  docIds: string[],
): Array<{ session: SessionLike; messages: number }> {
  if (docIds.length === 0) return [];

  const affected: Array<{ session: SessionLike; messages: number }> = [];
  for (const session of sessions) {
    let count = 0;
    for (const message of session.messages ?? []) {
      const sections = message.retrieval?.sections ?? [];
      if (
        sections.some((section) =>
          docIds.some(
            (docId) => !!section.id && sectionBelongsToDoc(section.id, docId),
          ),
        )
      ) {
        count += 1;
      }
    }

    // 手动勾选的片段也算受影响（虽然不会立刻坏，但删除后这条勾选会消失）
    const pinned = session.knowledge?.sectionIds ?? [];
    if (
      pinned.some((id) =>
        docIds.some((docId) => sectionBelongsToDoc(id, docId)),
      )
    ) {
      count += 1;
    }

    if (count > 0) affected.push({ session, messages: count });
  }

  return affected.sort((a, b) => b.messages - a.messages);
}

export type StripResult = {
  /** 被清掉的片段条数 */
  removedSections: number;
  /** 清空后不再引用知识库的消息条数 */
  clearedMessages: number;
  /** 被清掉的勾选片段条数 */
  removedPinned: number;
};

/**
 * 就地清掉会话里属于这些文档的引用。
 *
 * @param session 会话（会被就地修改，调用方负责触发响应式更新）
 * @param docIds 要删除的文档 id
 */
export function stripDocReferences(
  session: SessionLike,
  docIds: string[],
): StripResult {
  const result: StripResult = {
    removedSections: 0,
    clearedMessages: 0,
    removedPinned: 0,
  };
  if (docIds.length === 0) return result;

  for (const message of session.messages ?? []) {
    const sections = message.retrieval?.sections;
    if (!sections || sections.length === 0) continue;

    const sectionId = (section: RetrievalSection) => section.id ?? "";
    const kept = sections.filter(
      (section) =>
        !docIds.some((docId) => sectionBelongsToDoc(sectionId(section), docId)),
    );
    if (kept.length === sections.length) continue;

    result.removedSections += sections.length - kept.length;
    if (kept.length === 0) {
      delete message.retrieval;
      result.clearedMessages += 1;
    } else {
      message.retrieval = { ...message.retrieval!, sections: kept };
    }
  }

  const pinned = session.knowledge?.sectionIds;
  if (pinned && pinned.length > 0) {
    const kept = pinned.filter(
      (id) => !docIds.some((docId) => sectionBelongsToDoc(id ?? "", docId)),
    );
    if (kept.length !== pinned.length) {
      result.removedPinned = pinned.length - kept.length;
      session.knowledge = { ...session.knowledge, sectionIds: kept };
    }
  }

  return result;
}

/**
 * 从勾选里剔除已经失效的片段 id（文档被删 / 重新导入后 id 变了）。
 *
 * @param ids 当前勾选的 id
 * @param validIds 知识库里现存的 id
 */
export function filterValidSectionIds(
  ids: string[],
  validIds: Iterable<string>,
): { kept: string[]; removed: string[] } {
  const valid = new Set(validIds);
  const kept: string[] = [];
  const removed: string[] = [];
  for (const id of ids) {
    if (valid.has(id)) kept.push(id);
    else removed.push(id);
  }
  return { kept, removed };
}

/** 受影响的会话标题，用于删除前的提示（最多列几个） */
export function formatAffectedTopics(
  affected: Array<{ session: SessionLike }>,
  limit = 5,
): string {
  const names = affected
    .slice(0, limit)
    .map((item) => item.session.topic || "(无标题)");
  const rest = affected.length - names.length;
  return rest > 0
    ? `${names.join("、")} 等 ${affected.length} 个对话`
    : names.join("、");
}

export { docsOfMessage };
