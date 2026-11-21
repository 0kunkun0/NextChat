import React, { useState } from "react";

import Locale from "../locales";
import { useChatStore } from "../store/chat";
import { useSyncStore } from "../store/sync";
import { IconButton } from "./button";
import { List, ListItem, showToast } from "./ui-lib";
import DownloadIcon from "../icons/download.svg";
import { ImportSessionPicker } from "./import-session-picker";
import {
  listRemoteBackups,
  prepareSessionForImport,
  readRemoteBackup,
  toImportCandidates,
} from "../utils/cloud/backup-import";
import type { ImportedConversation } from "../utils/deepseek-import";

/**
 * 「从数据库导入其它备份」。
 *
 * 场景：同一个 Upstash 库里躺着好几份备份（换过索引名、多个部署共用同一个库），
 * 想把其中一份的对话挑几条拉回来。
 *
 * 流程：输入/列出备份名 → 读取（加密则验证密码）→ 弹窗勾选会话 → 追加到本地。
 */
export function RemoteBackupImportSection() {
  const syncStore = useSyncStore();
  const chatStore = useChatStore();

  const [name, setName] = useState("");
  const [available, setAvailable] = useState<string[] | null>(null);
  const [listing, setListing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [candidates, setCandidates] = useState<ImportedConversation[] | null>(
    null,
  );

  const handleList = async () => {
    setListing(true);
    try {
      const names = await listRemoteBackups(syncStore);
      setAvailable(names);
      if (names.length === 0) {
        showToast(Locale.Settings.RemoteImport.NoBackups);
      }
    } catch (e: any) {
      console.error("[RemoteImport] list failed", e);
      showToast(
        Locale.Settings.RemoteImport.ListFailed(String(e?.message ?? e)),
      );
    } finally {
      setListing(false);
    }
  };

  const handleRead = async () => {
    const target = name.trim();
    if (!target) {
      showToast(Locale.Settings.RemoteImport.NeedName);
      return;
    }

    setBusy(true);
    try {
      const localIds = chatStore.sessions.map((session) => session.id);
      // 加密备份会在这里弹窗要密码（本机已有匹配钥匙则直接复用）
      const { sessions, encrypted } = await readRemoteBackup(
        syncStore,
        target,
        {
          localIds,
        },
      );
      const list = toImportCandidates(sessions, localIds);
      if (list.length === 0) {
        showToast(Locale.Settings.RemoteImport.Empty);
        return;
      }
      if (encrypted) console.info("[RemoteImport] backup is encrypted");
      setCandidates(list);
    } catch (e: any) {
      const message = String(e?.message ?? e);
      console.error("[RemoteImport] read failed", e);
      showToast(
        message.includes("DECRYPT_FAILED")
          ? Locale.Settings.RemoteImport.WrongPassword
          : Locale.Settings.RemoteImport.ReadFailed(message),
      );
    } finally {
      setBusy(false);
    }
  };

  const finishImport = (picked: ImportedConversation[]) => {
    setCandidates(null);
    if (picked.length === 0) return;

    const taken = new Set(chatStore.sessions.map((session) => session.id));
    let renamed = 0;
    const additions = picked.map((item) => {
      const prepared = prepareSessionForImport(item.session, taken);
      if (prepared.renamed) renamed += 1;
      return prepared.session;
    });

    // 追加到列表末尾并选中第一条导入的（和「从 DeepSeek 导入」一致）
    const startIndex = useChatStore.getState().sessions.length;
    useChatStore.setState((state) => ({
      sessions: [...state.sessions, ...additions],
      currentSessionIndex: startIndex,
    }));

    showToast(
      renamed > 0
        ? Locale.Settings.RemoteImport.ImportedRenamed(
            additions.length,
            renamed,
          )
        : Locale.Settings.RemoteImport.Imported(additions.length),
    );
  };

  return (
    <>
      <List>
        <ListItem
          title={Locale.Settings.RemoteImport.Title}
          subTitle={Locale.Settings.RemoteImport.SubTitle}
        >
          <IconButton
            icon={<DownloadIcon />}
            text={Locale.Settings.RemoteImport.List}
            onClick={handleList}
            disabled={listing}
          />
        </ListItem>

        <ListItem
          title={Locale.Settings.RemoteImport.NameTitle}
          subTitle={
            available && available.length > 0
              ? Locale.Settings.RemoteImport.NameSubTitle(available.length)
              : Locale.Settings.RemoteImport.NameSubTitleHint
          }
        >
          <div className="remote-import-controls">
            <input
              className="remote-import-input"
              list="remote-backup-names"
              value={name}
              placeholder={Locale.Settings.RemoteImport.NamePlaceholder}
              onChange={(e) => setName(e.currentTarget.value)}
            />
            <datalist id="remote-backup-names">
              {(available ?? []).map((item) => (
                <option key={item} value={item} />
              ))}
            </datalist>
            <IconButton
              text={
                busy
                  ? Locale.Settings.RemoteImport.Reading
                  : Locale.Settings.RemoteImport.Read
              }
              onClick={handleRead}
              disabled={busy}
            />
          </div>
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
