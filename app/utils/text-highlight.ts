/**
 * 把文本按关键字切成「命中 / 未命中」片段，交给界面渲染成 `<mark>`。
 *
 * 用 indexOf 而不是正则：用户输入里的 `(`、`[`、`*` 之类不会炸正则，
 * 也不需要转义。搜索聊天记录、知识库片段预览都用它。
 */

export type HighlightPart = { text: string; hit: boolean };

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
