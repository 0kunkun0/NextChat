import { getMessageTextContent } from "../utils";
import type { ChatSession } from "../store/chat";

/**
 * 「搜索聊天记录」的检索逻辑（纯函数，便于单测）。
 *
 * 之前的问题：
 *   1. 只把 `message.content as string` 当文本，带图片/文件的消息（content 是数组）
 *      直接被跳过 → 搜不到；
 *   2. 每个会话只拼了第一段摘要，界面上又只截前 70 字 → 一条会话里命中多处时
 *      只看到其中一处。
 *
 * 现在按「会话 → 命中列表」返回，每一处命中都带 messageId / 片段，
 * 界面可以逐条展示、点击直接跳到那条消息。
 */

export type ChatSearchMatch = {
  messageId: string;
  messageIndex: number;
  role: string;
  /** 命中处前后的片段（已压缩空白） */
  snippet: string;
  /** 这条消息里的第几处命中（从 1 开始） */
  matchIndex: number;
};

export type ChatSearchResult = {
  sessionIndex: number;
  sessionId: string;
  topic: string;
  matches: ChatSearchMatch[];
};

export type SearchOptions = {
  /** 片段里命中词前后各保留多少字符 */
  contextChars?: number;
  /** 每个会话最多保留多少处命中 */
  perSession?: number;
};

const DEFAULT_CONTEXT = 40;
const DEFAULT_PER_SESSION = 30;

/** 压缩空白，避免片段里一堆换行/缩进 */
function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * @param sessions 全部会话
 * @param keyword 关键词（忽略大小写，首尾空白去掉）
 */
export function searchSessions(
  sessions: ChatSession[],
  keyword: string,
  options: SearchOptions = {},
): ChatSearchResult[] {
  const needle = keyword.trim().toLowerCase();
  if (!needle) return [];

  const contextChars = options.contextChars ?? DEFAULT_CONTEXT;
  const perSession = options.perSession ?? DEFAULT_PER_SESSION;

  const results: ChatSearchResult[] = [];

  sessions.forEach((session, sessionIndex) => {
    const matches: ChatSearchMatch[] = [];
    const seenSnippets = new Set<string>();

    for (
      let messageIndex = 0;
      messageIndex < session.messages.length;
      messageIndex += 1
    ) {
      const message = session.messages[messageIndex];
      // 用统一的取文本方法：数组形式（图片 / 文件 / 文本块）也能搜到
      const text = getMessageTextContent(message);
      if (!text) continue;

      const lower = text.toLowerCase();
      let pos = lower.indexOf(needle);
      let matchIndex = 0;
      /** 上一个命中的位置：用来折叠「连续紧挨着」的重复（abcabcabc 这种） */
      let prevHitPos = -1;

      while (pos !== -1) {
        matchIndex += 1;
        const start = Math.max(0, pos - contextChars);
        const end = Math.min(text.length, pos + needle.length + contextChars);
        const snippet = collapse(text.slice(start, end));

        /**
         * 去重两条：
         *   - 片段文字完全相同（关键词在片段里重复出现）；
         *   - 命中和上一处**紧挨着**（abcabcabc 这种连续重复）→ 只留一条。
         *
         * 注意不要按“窗口重叠”去重：像「第0次 hit，第1次 hit」这种
         * 短句里连续多次命中，窗口确实会重叠，但那确实是多处，应该列出来。
         */
        const chained = prevHitPos >= 0 && pos === prevHitPos + needle.length;
        prevHitPos = pos;
        if (!seenSnippets.has(snippet) && !chained) {
          seenSnippets.add(snippet);
          matches.push({
            messageId: message.id ?? "",
            messageIndex,
            role: message.role,
            snippet: `${start > 0 ? "…" : ""}${snippet}${
              end < text.length ? "…" : ""
            }`,
            matchIndex,
          });
        }

        if (matches.length >= perSession) break;
        pos = lower.indexOf(needle, pos + needle.length);
      }

      if (matches.length >= perSession) break;
    }

    if (matches.length > 0) {
      results.push({
        sessionIndex,
        sessionId: session.id,
        topic: session.topic,
        matches,
      });
    }
  });

  // 命中多的会话排前面；数量相同按标题排，保证结果稳定
  results.sort(
    (a, b) =>
      b.matches.length - a.matches.length ||
      a.topic.localeCompare(b.topic, "zh-Hans-CN"),
  );

  return results;
}

/** 总命中数（给标题上的统计用） */
export function countMatches(results: ChatSearchResult[]): number {
  return results.reduce((sum, item) => sum + item.matches.length, 0);
}
