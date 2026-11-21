import React, { useRef, useState } from "react";

import Locale from "../locales";
import { useChatStore } from "../store/chat";
import { List, ListItem, showToast } from "./ui-lib";
import { IconButton } from "./button";
import UploadIcon from "../icons/upload.svg";
import { ImportSessionPicker } from "./import-session-picker";
import {
  MAX_IMPORT_BYTES,
  parseDeepseekExport,
  type ImportedConversation,
} from "../utils/deepseek-import";

/**
 * 导入 DeepSeek 官网导出的会话（`deepseek_data-*.zip`）。
 *
 * 流程：选文件 → 本地解析 → **弹窗勾选要导入哪些会话**（置顶的在最上面，
 * 其余按更新时间倒序，默认全选）→ 只把勾选的追加到会话列表末尾。
 * 全程在浏览器本地完成，不上传服务器。
 */
export function DeepseekImportSection() {
  const [busy, setBusy] = useState(false);
  const [candidates, setCandidates] = useState<ImportedConversation[] | null>(
    null,
  );
  /** 解析时被跳过（损坏 / 已被过滤）的条数，用于最后汇总 */
  const [skippedCount, setSkippedCount] = useState(0);
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

      // 本地已有同标题的会话直接排除，避免重复导入
      const existingTopics = new Set(
        useChatStore.getState().sessions.map((session) => session.topic),
      );
      const available = imported.filter(
        (item) => !existingTopics.has(item.title),
      );
      const duplicated = imported.length - available.length;

      if (available.length === 0) {
        showToast(
          Locale.Settings.DeepseekImport.AllDuplicated(imported.length),
        );
        return;
      }

      setSkippedCount(skipped.length + duplicated);
      setCandidates(available);
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

  const finishImport = (picked: ImportedConversation[]) => {
    if (!candidates) return;
    if (picked.length === 0) {
      showToast(Locale.Settings.DeepseekImport.NoneSelected);
      return;
    }

    const startIndex = useChatStore.getState().sessions.length;
    useChatStore.setState((state) => ({
      sessions: [...state.sessions, ...picked.map((item) => item.session)],
      // 选中第一条导入的会话，回到聊天页就能看到
      currentSessionIndex: startIndex,
    }));

    showToast(
      Locale.Settings.DeepseekImport.Success(
        picked.length,
        skippedCount + (candidates.length - picked.length),
      ),
    );
    setCandidates(null);
  };

  return (
    <>
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

      {candidates && (
        <ImportSessionPicker
          candidates={candidates}
          onCancel={() => setCandidates(null)}
          onImport={finishImport}
        />
      )}
    </>
  );
}
