import React, { useRef, useState } from "react";

import Locale from "../locales";
import { useChatStore } from "../store/chat";
import { List, ListItem, showToast } from "./ui-lib";
import { IconButton } from "./button";
import UploadIcon from "../icons/upload.svg";
import {
  MAX_IMPORT_BYTES,
  parseDeepseekExport,
} from "../utils/deepseek-import";

/**
 * 导入 DeepSeek 官网导出的会话（`deepseek_data-*.zip`）。
 *
 * 只在浏览器本地解析，不上传服务器；导入的会话**追加**到列表末尾，
 * 不会覆盖已有会话。同名（同标题）的会话会跳过，避免重复导入。
 */
export function DeepseekImportSection() {
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File) => {
    if (file.size > MAX_IMPORT_BYTES) {
      showToast(
        Locale.Settings.DeepseekImport.Failed(
          Locale.Settings.DeepseekImport.TooLarge,
        ),
      );
      return;
    }

    setBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { imported, skipped } = parseDeepseekExport(bytes);

      if (imported.length === 0) {
        showToast(Locale.Settings.DeepseekImport.NoImportable(skipped.length));
        return;
      }

      // 已有同标题的会话就跳过，避免同一个文件导两次出现两份
      const existingTopics = new Set(
        useChatStore.getState().sessions.map((session) => session.topic),
      );
      const fresh = imported.filter((item) => !existingTopics.has(item.title));
      const duplicated = imported.length - fresh.length;

      if (fresh.length === 0) {
        showToast(
          Locale.Settings.DeepseekImport.AllDuplicated(imported.length),
        );
        return;
      }

      const startIndex = useChatStore.getState().sessions.length;
      useChatStore.setState((state) => ({
        sessions: [...state.sessions, ...fresh.map((item) => item.session)],
        // 选中第一条导入的会话，用户回到聊天页就能看到
        currentSessionIndex: startIndex,
      }));

      showToast(
        Locale.Settings.DeepseekImport.Success(
          fresh.length,
          skipped.length + duplicated,
        ),
      );
    } catch (e: any) {
      const reason = String(e?.message ?? e);
      showToast(
        Locale.Settings.DeepseekImport.Failed(
          Locale.Settings.DeepseekImport.Reason(reason),
        ),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <List>
      <ListItem
        title={Locale.Settings.DeepseekImport.Title}
        subTitle={Locale.Settings.DeepseekImport.SubTitle}
      >
        <IconButton
          icon={<UploadIcon />}
          text={
            busy
              ? Locale.Settings.DeepseekImport.Importing
              : Locale.Settings.DeepseekImport.Button
          }
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        />
        <input
          ref={inputRef}
          type="file"
          accept=".zip,application/zip"
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            e.currentTarget.value = "";
            if (file) handleFile(file);
          }}
        />
      </ListItem>
    </List>
  );
}
