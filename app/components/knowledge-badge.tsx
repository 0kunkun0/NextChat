import React, { useMemo } from "react";

import Locale from "../locales";
import { useKnowledgeStore } from "../store/knowledge";

type RetrievalSection = {
  id?: string;
  headingPath: string;
  docName: string;
  chars: number;
};

/**
 * 消息上的「📚 知识库 N 节 · M token」标记。
 *
 * 数字不是从消息里存的旧值直接拿的：知识库文档被重新导入 / 删除后，
 * 引用的片段 id 可能已经不存在了。这里按 id 去当前索引里查一遍：
 *   - 全都还在 → 用当前的字数估算 token；
 *   - 有一部分没了 → 只算还在的；
 *   - 全都没了 → 整个标记不显示（那条消息实际上已经不带知识库了）。
 */
export function KnowledgeBadge(props: {
  sections: RetrievalSection[];
  tokens: number;
  /** 会话里手动勾选的片段：有就优先显示它（改完勾选立刻生效） */
  pinnedIds?: string[];
}) {
  const index = useKnowledgeStore((state) => state.index);

  /**
   * 这里**不要**主动 refresh：那会为了展示一个标记就把 1.6MB 分块读出来、
   * 重算一遍 BM25 索引（下载刚结束时最贵）。索引还没建时直接用消息里存的数字。
   */

  /**
   * 勾选了片段就以勾选为准（这是「用户点名要注入的」），
   * 否则用消息上记录的自动检索结果。
   */
  const requestedIds =
    props.pinnedIds && props.pinnedIds.length > 0
      ? props.pinnedIds
      : props.sections.map((section) => section.id ?? "");
  const requested = requestedIds.length;

  const live = useMemo(() => {
    if (!index) return null;
    const byId = new Map(index.chunks.map((chunk) => [chunk.id, chunk]));
    return requestedIds
      .map((id) => (id ? byId.get(id) : undefined))
      .filter((chunk): chunk is NonNullable<typeof chunk> => !!chunk);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, props.sections, props.pinnedIds]);

  // 索引已加载但一个都找不到：说明引用的文档都被删了
  if (live && live.length === 0) return null;

  const count = live ? live.length : requested;
  const tokens = live
    ? live.reduce((sum, chunk) => sum + chunk.estTokens, 0)
    : props.tokens;
  const titles = live
    ? live.map((chunk) => chunk.headingPath || chunk.heading)
    : props.sections.map((section) => section.headingPath);

  // 勾选了却只注入一部分（预算不够）：把比例标出来
  const partial = requested > 0 && count < requested;

  return (
    <div
      className="knowledge-badge"
      title={
        partial && props.pinnedIds
          ? `${titles.join("\n")}\n\n${Locale.Chat.Knowledge.BadgePartialHint}`
          : titles.join("\n")
      }
    >
      {partial
        ? Locale.Chat.Knowledge.BadgePartial(count, requested, tokens)
        : Locale.Chat.Knowledge.Badge(count, tokens)}
    </div>
  );
}
