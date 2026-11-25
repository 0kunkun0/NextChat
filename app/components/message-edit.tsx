import React, { useMemo, useRef, useState } from "react";

import Locale from "../locales";
import { IconButton } from "./button";
import { Modal, showToast } from "./ui-lib";
import ConfirmIcon from "../icons/confirm.svg";
import CancelIcon from "../icons/cancel.svg";
import AddIcon from "../icons/add.svg";
import DeleteIcon from "../icons/delete.svg";
import { createPortalLayer } from "../utils/portal";
import {
  ACCEPT_FILE,
  MAX_ATTACHMENTS,
  deleteFile,
  getMaxSizeMB,
  getUploadPurpose,
  isImageFile,
  toChatAttachment,
  uploadFile,
} from "../utils/attachments";
import { formatSize } from "../utils/attachment-rules";
import type { ChatAttachment, ChatMessage } from "../store/chat";

/**
 * 消息气泡上的「编辑」。
 *
 * 以前这个按钮只弹一个文本框改文字，想改「是否生成完毕」或者增删附件
 * 得跑去「编辑消息记录」弹窗里翻半天。现在改成一个小弹窗，一次能改：
 *   - 正文（沿用原来的 textarea 行为）；
 *   - assistant：生成完毕（取消勾选后消息上会出现「继续生成」）；
 *   - user：附件（可以删掉已有文件，也可以再传新的）。
 */

export type MessageEditResult = {
  text: string;
  attachments: ChatAttachment[];
  /** assistant 消息才用得到 */
  isComplete?: boolean;
};

type DialogProps = {
  message: ChatMessage;
  initial: MessageEditResult;
  onCancel: () => void;
  onConfirm: (result: MessageEditResult) => void;
};

function MessageEditDialog(props: DialogProps) {
  const { message } = props;
  const isAssistant = message.role === "assistant";
  const isUser = message.role === "user";

  const [text, setText] = useState(props.initial.text);
  const [attachments, setAttachments] = useState<ChatAttachment[]>(
    props.initial.attachments,
  );
  const [isComplete, setIsComplete] = useState(
    props.initial.isComplete !== false,
  );
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = async (files: File[]) => {
    if (files.length === 0) return;
    const room = Math.max(0, MAX_ATTACHMENTS - attachments.length);
    if (room === 0) {
      showToast(Locale.Chat.Attachments.TooMany(MAX_ATTACHMENTS));
      return;
    }

    // 多选时 props 不会立刻更新，本地累积避免互相覆盖
    let current = attachments.slice();
    const append = (items: ChatAttachment[]) => {
      current = [...current, ...items];
      setAttachments(current);
    };

    setBusy(true);
    try {
      for (const file of files.slice(0, room)) {
        const isImage = isImageFile(file);
        if (!getUploadPurpose(file.name, isImage)) {
          showToast(Locale.Chat.Attachments.Unsupported(file.name));
          continue;
        }
        const maxMB = getMaxSizeMB(file.name, isImage);
        if (file.size > maxMB * 1024 * 1024) {
          showToast(Locale.Chat.Attachments.TooLarge(file.name, maxMB));
          continue;
        }

        try {
          const object = await uploadFile(file);
          append([toChatAttachment(file, object)]);
        } catch (e: any) {
          showToast(Locale.Chat.Attachments.UploadFailed(e?.message ?? ""));
        }
      }
    } finally {
      setBusy(false);
    }
  };

  const removeAttachment = async (item: ChatAttachment) => {
    setAttachments((list) => list.filter((entry) => entry.id !== item.id));
    if (item.fileId) {
      const ok = await deleteFile(item.fileId);
      if (!ok) showToast(Locale.Chat.Attachments.DeleteFailed);
    }
  };

  return (
    <div className="modal-mask">
      <Modal
        title={Locale.Chat.MessageEdit.Title}
        onClose={props.onCancel}
        defaultMax
        actions={[
          <IconButton
            key="cancel"
            icon={<CancelIcon />}
            text={Locale.Chat.MessageEdit.Cancel}
            onClick={props.onCancel}
          />,
          <IconButton
            key="ok"
            type="primary"
            icon={<ConfirmIcon />}
            text={Locale.Chat.MessageEdit.Confirm}
            onClick={() =>
              props.onConfirm({
                text,
                attachments,
                isComplete: isAssistant ? isComplete : undefined,
              })
            }
          />,
        ]}
      >
        <div className="message-edit">
          <textarea
            className="message-edit-text"
            value={text}
            rows={6}
            placeholder={Locale.Chat.MessageEdit.TextPlaceholder}
            onChange={(e) => setText(e.currentTarget.value)}
          />

          {isAssistant && (
            <label className="message-edit-complete">
              <input
                type="checkbox"
                checked={isComplete}
                onChange={(e) => setIsComplete(e.currentTarget.checked)}
              />
              <span>{Locale.Chat.EditMessage.Complete.Label}</span>
              <span className="message-edit-hint">
                {isComplete ? "" : Locale.Chat.MessageEdit.CompleteOffHint}
              </span>
            </label>
          )}

          {isUser && (
            <div className="message-edit-attachments">
              <div className="message-edit-attachments-head">
                <span>{Locale.Chat.MessageEdit.Attachments}</span>
                <IconButton
                  icon={<AddIcon />}
                  text={
                    busy
                      ? Locale.Chat.Attachments.Uploading
                      : Locale.Chat.Attachments.Button
                  }
                  disabled={busy}
                  onClick={() => inputRef.current?.click()}
                />
                <input
                  ref={inputRef}
                  type="file"
                  multiple
                  accept={ACCEPT_FILE}
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const files = Array.from(e.currentTarget.files ?? []);
                    e.currentTarget.value = "";
                    void handleFiles(files);
                  }}
                />
              </div>

              {attachments.length === 0 ? (
                <div className="message-edit-empty">
                  {Locale.Chat.MessageEdit.NoAttachments}
                </div>
              ) : (
                <div className="message-edit-list">
                  {attachments.map((item) => (
                    <div key={item.id} className="message-edit-item">
                      <span className="message-edit-item-name">
                        {item.name}
                      </span>
                      <span className="message-edit-item-meta">
                        {formatSize(item.bytes)}
                      </span>
                      <IconButton
                        icon={<DeleteIcon />}
                        text={Locale.Chat.Attachments.Delete}
                        onClick={() => void removeAttachment(item)}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}

/** 命令式调用：返回用户编辑后的内容，取消返回 null */
export function showMessageEdit(options: {
  message: ChatMessage;
  initial: MessageEditResult;
}): Promise<MessageEditResult | null> {
  const layer = createPortalLayer();
  return new Promise<MessageEditResult | null>((resolve) => {
    const finish = (value: MessageEditResult | null) => {
      layer.destroy();
      resolve(value);
    };
    layer.root.render(
      <MessageEditDialog
        message={options.message}
        initial={options.initial}
        onCancel={() => finish(null)}
        onConfirm={(result) => finish(result)}
      />,
    );
  });
}
