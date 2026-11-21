import React, { useEffect, useMemo } from "react";

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
}) {
  const index = useKnowledgeStore((state) => state.index);
  const refresh = useKnowledgeStore((state) => state.refresh);

  useEffect(() => {
    if (!index) void refresh();
  }, [index, refresh]);

  const live = useMemo(() => {
    if (!index) return null;
    const byId = new Map(index.chunks.map((chunk) => [chunk.id, chunk]));
    return props.sections
      .map((section) => (section.id ? byId.get(section.id) : undefined))
      .filter((chunk): chunk is NonNullable<typeof chunk> => !!chunk);
  }, [index, props.sections]);

  // 索引已加载但一个都找不到：说明引用的文档都被删了
  if (live && live.length === 0) return null;

  const count = live ? live.length : props.sections.length;
  const tokens = live
    ? live.reduce((sum, chunk) => sum + chunk.estTokens, 0)
    : props.tokens;
  const titles = live
    ? live.map((chunk) => chunk.headingPath || chunk.heading)
    : props.sections.map((section) => section.headingPath);

  return (
    <div className="knowledge-badge" title={titles.join("\n")}>
      {Locale.Chat.Knowledge.Badge(count, tokens)}
    </div>
  );
}
