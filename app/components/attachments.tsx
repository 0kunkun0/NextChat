import React from "react";

import type { ChatAttachment } from "../store/chat";
import { formatSize, getFileExt } from "../utils/attachment-rules";

// rebuildContent 放在纯规则模块里（可单测、无重依赖），这里透出给调用方
export { rebuildContent } from "../utils/attachment-rules";

/**
 * 附件相关的展示组件。
 *
 * 输入框 / 编辑消息 / 消息本体三处共用，保证「图片能删、文件能删」的行为一致。
 */

/** 文件类型对应的简短标签（PDF / DOCX / TXT …） */
function extLabel(name: string) {
  const ext = getFileExt(name);
  return ext ? ext.toUpperCase() : "FILE";
}

export function AttachmentChips(props: {
  items: ChatAttachment[];
  onRemove?: (id: string) => void;
  /** 上传中 / 失败的状态文案 */
  statusOf?: (id: string) => string | undefined;
}) {
  if (props.items.length === 0) return null;

  return (
    <div className="attachment-chips">
      {props.items.map((item) => {
        const status = props.statusOf?.(item.id);
        return (
          <div
            key={item.id}
            className={`attachment-chip${status ? " is-pending" : ""}`}
            title={item.name}
          >
            {item.kind === "image" && item.url ? (
              <img className="attachment-chip-thumb" src={item.url} alt="" />
            ) : (
              <span className="attachment-chip-ext">{extLabel(item.name)}</span>
            )}
            <span className="attachment-chip-name">{item.name}</span>
            <span className="attachment-chip-size">
              {status ?? formatSize(item.bytes)}
            </span>
            {props.onRemove && (
              <button
                type="button"
                className="attachment-chip-remove"
                aria-label={`删除附件 ${item.name}`}
                onClick={() => props.onRemove?.(item.id)}
              >
                ×
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** 消息里展示附件卡片；`onDelete` 存在时可删除（文件 / 未渲染成图片的附件） */
export function MessageAttachments(props: {
  attachments?: ChatAttachment[];
  onDelete?: (id: string) => void;
}) {
  // 图片已经由消息里的缩略图单独渲染，这里只列文件卡片，避免重复显示
  const items = (props.attachments ?? []).filter(
    (item) => item.kind === "file" || !item.url,
  );
  if (items.length === 0) return null;

  return (
    <div className="message-attachments">
      {items.map((item) => (
        <div key={item.id} className="message-attachment" title={item.name}>
          {item.kind === "image" && item.url ? (
            <img
              className="message-attachment-thumb"
              src={item.url}
              alt={item.name}
            />
          ) : (
            <span className="message-attachment-ext">
              {extLabel(item.name)}
            </span>
          )}
          <div className="message-attachment-info">
            <div className="message-attachment-name">{item.name}</div>
            <div className="message-attachment-meta">
              {formatSize(item.bytes)}
              {item.fileId ? " · 已上传" : ""}
            </div>
          </div>
          {props.onDelete && (
            <button
              type="button"
              className="message-attachment-remove"
              aria-label={`删除附件 ${item.name}`}
              onClick={() => props.onDelete?.(item.id)}
            >
              ×
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
