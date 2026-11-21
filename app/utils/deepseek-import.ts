import { strFromU8, unzipSync } from "fflate";

import {
  createMessage,
  type ChatMessage,
  type ChatSession,
} from "../store/chat";
import { createEmptyMask } from "../store/mask";

/**
 * 从 DeepSeek 官网导出的会话压缩包（`deepseek_data-*.zip`）导入到本地会话。
 *
 * 导出结构（export_format_version = 3）：
 *   manifest.json              { export_format_version }
 *   chat_session_index.json    [{ id, inserted_at, updated_at, ... }]
 *   chat_sessions/{id}.json    { title, current_message_id, messages: [...] }
 *   chat_sessions/{id}_files/  图片等附件（这里只记录文件名，不导入二进制）
 *
 * 每个 message 是一条消息树节点，`current_message_id` 决定导入哪条分支
 * （缺失时取 id 最大的叶子）。fragment 类型：
 *   REQUEST / RESPONSE / THINK / TEMPLATE_RESPONSE / TOOL_SEARCH / TOOL_OPEN /
 *   TOOL_FIND / READ_LINK / TOOL_IMAGE_SEARCH / PARTIAL_FILE_READ / TIP / FILE
 *
 * 映射成 NextChat 的 `ChatSession`：
 *   - USER 消息 → role: "user"，多个 REQUEST 用换行连接，附件列成一行
 *   - ASSISTANT → role: "assistant"，THINK 用引用块、搜索/打开网页用链接行
 *   - 被撤回 / 未完成 / 模板回复 → 标记 isError（渲染成错误行，不进模型上下文）
 */

export const SUPPORTED_EXPORT_FORMAT_VERSION = 3;
/** 浏览器里一次性解压的内存上限 */
export const MAX_IMPORT_BYTES = 128 * 1024 * 1024;

const MANIFEST_ENTRY = "manifest.json";
const INDEX_ENTRY = "chat_session_index.json";

export type DeepseekFragment = { type: string } & Record<string, any>;

export interface DeepseekMessage {
  id: number;
  parent_id: number | null;
  role: "USER" | "ASSISTANT";
  status: string;
  inserted_at: string;
  fragments: DeepseekFragment[];
}

export interface DeepseekConversationFile {
  id: string;
  title: string | null;
  current_message_id?: number | null;
  inserted_at: string;
  messages: DeepseekMessage[];
}

export interface SkippedConversation {
  id: string;
  title: string | null;
  reason: string;
}

export interface ImportedConversation {
  /** 导出里的会话 id */
  exportId: string;
  title: string;
  session: ChatSession;
  /** 导出索引里是否置顶 */
  pinned: boolean;
  /** 导出索引里的更新时间（毫秒），用来排序 */
  updatedAt: number;
  /** 消息条数，选会话时给用户看的参考 */
  messageCount: number;
}

export interface DeepseekImportResult {
  imported: ImportedConversation[];
  skipped: SkippedConversation[];
}

/** 导入时的可选项 */
export interface DeepseekImportOptions {
  /** 是否把 THINK 片段写成引用块（默认 true） */
  includeThinking?: boolean;
  /** 是否把联网搜索 / 打开网页的记录写成链接行（默认 true） */
  includeWeb?: boolean;
  /** id 生成器（测试里可以固定） */
  createId?: () => string;
}

const defaultCreateId = () =>
  `dsi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** 读压缩包并解析出所有可导入的会话 */
export function parseDeepseekExport(
  bytes: Uint8Array,
  options: DeepseekImportOptions = {},
): DeepseekImportResult {
  if (bytes.length > MAX_IMPORT_BYTES) {
    throw new Error("too-large");
  }

  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error("unreadable-archive");
  }

  // manifest.json：只认 v3
  const manifestRaw = files[MANIFEST_ENTRY];
  if (!manifestRaw) throw new Error("missing-manifest");
  let manifest: any;
  try {
    manifest = JSON.parse(strFromU8(manifestRaw));
  } catch {
    throw new Error("missing-manifest");
  }
  if (
    Number(manifest?.export_format_version) !== SUPPORTED_EXPORT_FORMAT_VERSION
  ) {
    throw new Error("unsupported-version");
  }

  // chat_session_index.json：决定导入顺序（最近更新的在前）
  const indexRaw = files[INDEX_ENTRY];
  if (!indexRaw) throw new Error("missing-index");
  let index: any[];
  try {
    const parsed = JSON.parse(strFromU8(indexRaw));
    index = Array.isArray(parsed) ? parsed : [];
  } catch {
    throw new Error("missing-index");
  }

  const imported: ImportedConversation[] = [];
  const skipped: SkippedConversation[] = [];
  const seen = new Set<string>();

  for (const row of index) {
    const id = typeof row?.id === "string" ? row.id : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const entryName = `chat_sessions/${id}.json`;
    const raw = files[entryName];
    if (!raw) {
      skipped.push({ id, title: null, reason: "missing conversation file" });
      continue;
    }

    let file: DeepseekConversationFile;
    try {
      file = JSON.parse(strFromU8(raw));
    } catch {
      skipped.push({ id, title: null, reason: "invalid conversation json" });
      continue;
    }

    try {
      const title = normalizeTitle(file.title) ?? "未命名会话";
      const session = toChatSession(file, title, options);
      imported.push({
        exportId: id,
        title,
        session,
        pinned: row?.pinned === true,
        // 索引里的 updated_at 是 RFC3339；解析失败就退回会话自身的更新时间
        updatedAt: parseTimeOr(row?.updated_at, session.lastUpdate),
        messageCount: session.messages.length,
      });
    } catch (e: any) {
      skipped.push({
        id,
        title: normalizeTitle(file?.title),
        reason: String(e?.message ?? e),
      });
    }
  }

  // 置顶的排最前面，其余按更新时间倒序：导入弹窗里就是这个顺序
  imported.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });

  return { imported, skipped };
}

/** 解析时间串；失败时返回兜底值 */
function parseTimeOr(value: unknown, fallback: number): number {
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : fallback;
}

/** 把一条导出的会话转成 NextChat 的 ChatSession */
export function toChatSession(
  file: DeepseekConversationFile,
  title: string,
  options: DeepseekImportOptions = {},
): ChatSession {
  const createId = options.createId ?? defaultCreateId;
  const includeThinking = options.includeThinking !== false;
  const includeWeb = options.includeWeb !== false;

  const chain = selectBranch(file);
  const messages: ChatMessage[] = [];
  let turn = 0;

  for (let i = 0; i < chain.length; i++) {
    const user = chain[i];
    if (user.role !== "USER") continue;

    const next = chain[i + 1];
    const reply = next?.role === "ASSISTANT" ? next : undefined;
    if (reply) i++;

    // 整轮被内容过滤撤回了：按源工具的做法整轮跳过
    if (reply?.status === "CONTENT_FILTER") continue;

    turn += 1;
    const userText = describeUserMessage(user);
    const userTime = parseTime(user.inserted_at);
    messages.push(
      createMessage({
        id: createId(),
        role: "user",
        content: userText,
        date: formatDate(userTime),
      }),
    );

    if (!reply) {
      messages.push(
        createMessage({
          id: createId(),
          role: "assistant",
          content: "（导出里没有这条提问的回复）",
          date: formatDate(userTime),
          isError: true,
        }),
      );
      continue;
    }

    const replyTime = parseTime(reply.inserted_at) ?? userTime;
    const { content, excluded } = describeReply(reply, {
      includeThinking,
      includeWeb,
    });

    if (excluded || !content) {
      messages.push(
        createMessage({
          id: createId(),
          role: "assistant",
          content:
            content ||
            (excluded
              ? `（原始回复未包含在导出中：${excluded}）`
              : "（原始回复内容为空）"),
          date: formatDate(replyTime),
          // 标记错误：渲染成错误行，也不会进入后续请求的上下文
          isError: true,
        }),
      );
      continue;
    }

    messages.push(
      createMessage({
        id: createId(),
        role: "assistant",
        content,
        date: formatDate(replyTime),
        model: "deepseek-chat",
      }),
    );
  }

  if (turn === 0) {
    throw new Error("conversation has no importable turn");
  }

  const lastTime =
    parseTime(chain[chain.length - 1]?.inserted_at) ??
    parseTime(file.inserted_at);

  return {
    id: createId(),
    topic: title,
    memoryPrompt: "",
    messages,
    stat: {
      tokenCount: 0,
      wordCount: 0,
      charCount: messages.reduce((sum, m) => sum + m.content.length, 0),
    },
    lastUpdate: lastTime,
    lastSummarizeIndex: 0,
    mask: createEmptyMask(),
  };
}

/**
 * 选中要导入的分支：从 `current_message_id` 一路回溯到根。
 * 该字段缺失/无效时退回 id 最大的叶子。
 */
export function selectBranch(
  file: DeepseekConversationFile,
): DeepseekMessage[] {
  const list = Array.isArray(file?.messages) ? file.messages : [];
  if (list.length === 0) throw new Error("conversation has no messages");

  const byId = new Map<number, DeepseekMessage>();
  let newest: DeepseekMessage | undefined;
  for (const message of list) {
    if (typeof message?.id !== "number") continue;
    byId.set(message.id, message);
    if (!newest || message.id > newest.id) newest = message;
  }
  if (!newest) throw new Error("conversation has no messages");

  const currentId = file.current_message_id;
  const selected =
    currentId === null || currentId === undefined
      ? undefined
      : byId.get(currentId);

  const chain: DeepseekMessage[] = [];
  let cursor: DeepseekMessage | undefined = selected ?? newest;
  while (cursor) {
    if (chain.length > byId.size) throw new Error("message parent cycle");
    chain.push(cursor);
    if (cursor.parent_id === null || cursor.parent_id === undefined) break;
    cursor = byId.get(cursor.parent_id);
    if (!cursor)
      throw new Error(`missing parent ${chain[chain.length - 1].id}`);
  }
  return chain.reverse();
}

/** 用户消息：REQUEST 文本 + 附件清单 */
function describeUserMessage(message: DeepseekMessage): string {
  const lines: string[] = [];
  const files: string[] = [];

  for (const fragment of message.fragments ?? []) {
    if (fragment?.type === "REQUEST" && typeof fragment.content === "string") {
      lines.push(fragment.content);
    } else if (fragment?.type === "FILE" && Array.isArray(fragment.files)) {
      for (const file of fragment.files) {
        const name = basename(String(file?.file_name ?? "file"));
        const size = Number(file?.file_size ?? 0);
        files.push(size > 0 ? `- ${name}（${formatSize(size)}）` : `- ${name}`);
      }
    }
  }

  const text = lines.join("\n").trim();
  if (files.length === 0) return text;

  const attach = `📎 附件：\n${files.join("\n")}`;
  return text.length > 0 ? `${text}\n\n${attach}` : attach;
}

/** 助手回复：按站点的呈现方式拼成 Markdown，并给出排除原因 */
function describeReply(
  message: DeepseekMessage,
  options: { includeThinking: boolean; includeWeb: boolean },
): { content: string; excluded?: string } {
  const blocks: string[] = [];
  let template: string | undefined;

  for (const fragment of message.fragments ?? []) {
    switch (fragment?.type) {
      case "THINK": {
        if (!options.includeThinking) break;
        const text = String(fragment.content ?? "").trim();
        if (text) blocks.push(quote(text));
        break;
      }
      case "RESPONSE": {
        const text = String(fragment.content ?? "");
        if (text.trim()) blocks.push(text.trim());
        break;
      }
      case "TEMPLATE_RESPONSE": {
        template ??= String(fragment.content ?? "");
        break;
      }
      case "TOOL_SEARCH": {
        if (!options.includeWeb || fragment.status === "WIP") break;
        const queries = (fragment.queries ?? []).filter(
          (q: any) => typeof q === "string" && q.trim(),
        );
        const results = Array.isArray(fragment.results) ? fragment.results : [];
        const lines: string[] = [];
        if (queries.length > 0) {
          lines.push(`> 🔍 联网搜索：${queries.join(" / ")}`);
        }
        for (const result of results.slice(0, 5)) {
          const url = String(result?.url ?? "");
          const title = String(result?.title ?? "").trim() || url;
          if (url) lines.push(`- [${title}](${url})`);
        }
        if (lines.length > 0) blocks.push(lines.join("\n"));
        break;
      }
      case "TOOL_OPEN": {
        if (!options.includeWeb || fragment.status === "WIP") break;
        const url = String(fragment.url ?? "");
        if (!url) break;
        const title = String(fragment.title ?? "").trim() || url;
        blocks.push(`> 🌐 打开网页：[${title}](${url})`);
        break;
      }
      case "READ_LINK": {
        if (!options.includeWeb) break;
        const lines: string[] = [];
        for (const result of fragment.results ?? []) {
          const url = String(result?.url ?? "");
          const title = String(result?.title ?? "").trim();
          if (url && title) lines.push(`- [${title}](${url})`);
          else if (url) lines.push(url);
          else if (title) lines.push(title);
        }
        if (lines.length > 0) blocks.push(lines.join("\n"));
        break;
      }
      default:
        // TOOL_FIND / TOOL_IMAGE_SEARCH / PARTIAL_FILE_READ / TIP /
        // REQUEST / FILE / 未知类型：站点上也不显示，直接忽略
        break;
    }
  }

  if (template) {
    return { content: "", excluded: "服务端模板回复" };
  }
  if (message.status !== "FINISHED") {
    return { content: "", excluded: `原始回复状态 ${message.status}` };
  }
  return { content: blocks.join("\n\n") };
}

function quote(text: string) {
  return text
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
}

function normalizeTitle(title: unknown): string | null {
  if (typeof title !== "string") return null;
  const collapsed = title.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  return collapsed.length > 100 ? `${collapsed.slice(0, 100)}…` : collapsed;
}

function parseTime(value: unknown): number {
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : Date.now();
}

function formatDate(time: number): string {
  try {
    return new Date(time).toLocaleString();
  } catch {
    return String(time);
  }
}

function basename(name: string): string {
  const leaf = name.slice(
    Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1,
  );
  return leaf.trim() || "file";
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}
