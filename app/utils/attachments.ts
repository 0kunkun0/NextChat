import { DeepSeekApi } from "../client/platforms/deepseek";
import { getHeaders } from "../client/api";
import type { ChatAttachment } from "../store/chat";
import { isImageFile } from "./attachment-rules";

/**
 * DeepSeek Files API 的客户端封装。
 *
 * - 上传：`POST /files`（multipart，`purpose` 必须排在 `file` 之前）
 * - 列表：`GET /files?limit=&order=`
 * - 查询：`GET /files/{id}`
 * - 删除：`DELETE /files/{id}`
 *
 * 请求地址走 `DeepSeekApi.path()`，所以「自定义接口地址」和「直连 DeepSeek」
 * 两个开关都能生效。鉴权用当前配置的 DeepSeek Key（由 getHeaders 生成）。
 */

// 纯规则从 attachment-rules 透出，调用方只 import 这一个文件即可
export {
  ACCEPTED_EXTS,
  ACCEPT_FILE,
  MAX_ATTACHMENTS,
  MAX_DOCUMENT_MB,
  MAX_IMAGE_MB,
  MAX_USER_DATA_MB,
  formatSize,
  getFileExt,
  getMaxSizeMB,
  getUploadPurpose,
  isImageFile,
  rebuildContent,
} from "./attachment-rules";

export type FileObject = {
  id: string;
  object: "file";
  bytes: number;
  created_at: number;
  filename: string;
  purpose: string;
  expires_at?: number;
};

const basePath = () => new DeepSeekApi().path("files");

async function readError(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const body = JSON.parse(text);
    return body?.error?.message ?? body?.message ?? text ?? res.statusText;
  } catch {
    return text || res.statusText;
  }
}

/** 上传一个文件，返回 Files API 的文件对象 */
export async function uploadFile(
  file: File,
  options: { signal?: AbortSignal } = {},
): Promise<FileObject> {
  const { getUploadPurpose } = await import("./attachment-rules");
  const isImage = isImageFile(file);
  const purpose = getUploadPurpose(file.name, isImage);
  if (!purpose) {
    throw new Error(`不支持的文件类型：${file.name}`);
  }

  const form = new FormData();
  // 文档必须先写 purpose，再写 file
  form.append("purpose", purpose);
  form.append("file", file);

  const res = await fetch(basePath(), {
    method: "POST",
    // ignoreHeaders：不要带 Content-Type，交给浏览器生成 multipart boundary
    headers: getHeaders(true),
    body: form,
    signal: options.signal,
  });

  if (!res.ok) {
    throw new Error(await readError(res));
  }
  return (await res.json()) as FileObject;
}

/** 删除一个已上传的文件（失败不抛，返回是否成功） */
export async function deleteFile(fileId: string): Promise<boolean> {
  if (!fileId) return false;
  try {
    const res = await fetch(`${basePath()}/${encodeURIComponent(fileId)}`, {
      method: "DELETE",
      headers: getHeaders(true),
    });
    if (!res.ok) {
      console.warn("[Files] delete failed", fileId, res.status);
      return false;
    }
    return true;
  } catch (e) {
    console.warn("[Files] delete failed", fileId, e);
    return false;
  }
}

/** 列出已上传文件（用于排查配额 / 清理） */
export async function listFiles(
  options: { limit?: number; order?: "asc" | "desc" } = {},
): Promise<FileObject[]> {
  const query = new URLSearchParams({
    limit: String(options.limit ?? 100),
    order: options.order ?? "desc",
  });
  const res = await fetch(`${basePath()}?${query.toString()}`, {
    method: "GET",
    headers: getHeaders(true),
  });
  if (!res.ok) throw new Error(await readError(res));
  const body = (await res.json()) as { data?: FileObject[] };
  return body.data ?? [];
}

/** 本地上传成功后，构造消息里用的附件描述 */
export function toChatAttachment(
  file: File,
  object: FileObject,
): ChatAttachment {
  const isImage = isImageFile(file);
  return {
    id: `att-${object.id}`,
    kind: isImage ? "image" : "file",
    name: file.name || object.filename,
    bytes: object.bytes,
    mime: file.type || (isImage ? "image/*" : "application/octet-stream"),
    fileId: object.id,
    purpose: object.purpose,
  };
}

/** 把 File 读成 data URL（图片本地预览用） */
export function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
