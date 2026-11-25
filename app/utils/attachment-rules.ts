import type { MultimodalContent } from "../client/api";
import type { ChatAttachment } from "../store/chat";

/**
 * 附件的纯规则：类型判断、上传 purpose、大小上限、格式化、content 重建。
 *
 * 单独放一个模块是因为 `utils/attachments.ts` 会 import DeepSeekApi
 * （进而拉起 store / locales 整条链）；这些判断本身不依赖任何运行时，
 * 放这里既便于单测，也能被组件安全引用。
 */

/** 需要版面解析的文档：PDF / Word / PowerPoint */
const LAYOUT_EXTS = new Set(["pdf", "doc", "docx", "ppt", "pptx"]);

/** 按 user_data 上传的文件类型（文本、代码、表格、电子书） */
const USER_DATA_EXTS = new Set([
  "txt",
  "md",
  "markdown",
  "csv",
  "json",
  "jsonl",
  "yaml",
  "yml",
  "xml",
  "html",
  "htm",
  "log",
  "rtf",
  "xls",
  "xlsx",
  "epub",
  "mobi",
  "py",
  "js",
  "jsx",
  "ts",
  "tsx",
  "java",
  "c",
  "h",
  "cpp",
  "hpp",
  "cs",
  "go",
  "rs",
  "rb",
  "php",
  "swift",
  "kt",
  "scala",
  "sh",
  "bash",
  "sql",
  "toml",
  "ini",
  "css",
  "scss",
]);

/** 图片扩展名（由内容判断格式，这里只用于选择框过滤） */
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

/** 选择文件时允许的扩展名（对应 accept 属性） */
export const ACCEPTED_EXTS = Array.from(
  new Set([...LAYOUT_EXTS, ...USER_DATA_EXTS, ...IMAGE_EXTS]),
).sort();
export const ACCEPT_FILE = ACCEPTED_EXTS.map((ext) => `.${ext}`).join(",");

/** 单个文件大小上限（MB）：图片 64，文档 100，纯文本 / 表格 / 电子书 32 */
export const MAX_IMAGE_MB = 64;
export const MAX_DOCUMENT_MB = 100;
export const MAX_USER_DATA_MB = 32;
/** 一次最多挂几个附件 */
export const MAX_ATTACHMENTS = 20;

export function getFileExt(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function isImageFile(file: { name: string; type?: string }): boolean {
  if (file.type?.startsWith("image/")) return true;
  return IMAGE_EXTS.has(getFileExt(file.name));
}

/** 按扩展名决定上传时的 purpose；不支持的扩展名返回 null */
export function getUploadPurpose(
  name: string,
  isImage: boolean,
): "user_data" | "text_recognition" | "rich_layout_recognition" | null {
  if (isImage) return "user_data";
  const ext = getFileExt(name);
  if (LAYOUT_EXTS.has(ext)) return "rich_layout_recognition";
  if (USER_DATA_EXTS.has(ext)) return "user_data";
  return null;
}

export function getMaxSizeMB(name: string, isImage: boolean): number {
  if (isImage) return MAX_IMAGE_MB;
  return getUploadPurpose(name, false) === "user_data"
    ? MAX_USER_DATA_MB
    : MAX_DOCUMENT_MB;
}

export function formatSize(bytes: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * 根据「正文 + 附件」重建消息的 content。
 *
 * 编辑消息时不能只保留文本：图片块和文件块都要按附件清单重新生成，
 * 否则一编辑就会把附件从上下文里抹掉。
 */
export function rebuildContent(
  text: string,
  attachments: ChatAttachment[],
): MultimodalContent[] {
  const blocks: MultimodalContent[] = [];
  if (text) blocks.push({ type: "text", text });

  for (const item of attachments) {
    if (item.kind === "image" && item.url) {
      blocks.push({ type: "image_url", image_url: { url: item.url } });
    } else if (item.fileId) {
      blocks.push({ type: "file", file_id: item.fileId });
    }
  }
  return blocks;
}
/**
 * 从附件列表里挑出「已经上传完成、需要作为 file 内容块发给模型」的那些。
 *
 * 判据只有一条：**有 file_id**。
 *
 * 以前这里隐含要求 `kind === "file"`，于是通过「📎 上传文件」传的图片
 * （kind 是 "image"，但同样传到了 Files API、拿到了 file_id）会在发送时被丢掉：
 * 输入框有 chip、模型看不到、消息里也没有附件记录（编辑历史同样看不到）。
 *
 * @param attachments 输入框上挂的附件
 */
export function collectUploadedAttachments(
  attachments: ChatAttachment[] | undefined,
): ChatAttachment[] {
  return (attachments ?? []).filter((item) => !!item.fileId);
}

/** 还有附件正在上传（占位 chip 没有 file_id） */
export function hasPendingAttachments(
  attachments: ChatAttachment[] | undefined,
): boolean {
  return (attachments ?? []).some((item) => !item.fileId);
}
