import { useEffect, useState } from "react";
import Locale from "../locales";
import { useSyncStore } from "../store/sync";
import { getLocalAppState, setLocalAppState } from "../utils/sync";
import {
  MAX_BACKUP_LIMIT,
  MIN_BACKUP_LIMIT,
  getBackup,
  listBackups,
  parseBackup,
  onBackupsChanged,
  replaceBackupWithCurrent,
  saveBackup,
  type BackupMeta,
} from "../utils/backup";
import { IconButton } from "./button";
import { List, ListItem, showConfirm, showToast } from "./ui-lib";
import AddIcon from "../icons/add.svg";
import { StoreKey } from "../constant";

/**
 * 本地备份列表：多个时间点、可以任选一份与当前内容「交换」。
 * 备份不参与云同步，也不会被自动删除（除非超出数量上限 / 重置所有数据）。
 */
export function LocalBackupSection(props: {
  /** 外部（同步 / 下载）刚存过备份后，用来触发一次刷新 */
  refreshKey?: number;
}) {
  const syncStore = useSyncStore();
  const limit = syncStore.backupLimit;
  const [backups, setBackups] = useState<BackupMeta[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    setBackups(await listBackups());
  };

  useEffect(() => {
    void refresh();
  }, [props.refreshKey]);

  useEffect(() => {
    // 同步 / 下载在别的组件里存了备份，也让它立刻刷新
    return onBackupsChanged(() => void refresh());
  }, []);

  const formatTime = (time: number) =>
    time ? new Date(time).toLocaleString() : "";

  const kindLabel = (kind: BackupMeta["kind"]) => {
    if (kind === "auto") return Locale.Settings.Sync.Backup.KindAuto;
    if (kind === "swap") return Locale.Settings.Sync.Backup.KindSwap;
    return Locale.Settings.Sync.Backup.KindManual;
  };

  /**
   * 手动备份。
   * 移动端写 IndexedDB 可能因为配额失败，绝不能静默失败——
   * 失败必须弹提示，否则表现就是“点了没反应”。
   */
  const backupNow = async () => {
    if (busy) return;
    setBusy(true);
    showToast(Locale.Settings.Sync.Backup.Working);
    try {
      const record = await saveBackup(getLocalAppState(), "manual", limit);
      await refresh();
      showToast(
        record
          ? Locale.Settings.Sync.Backup.CreateDone(record.sessions)
          : Locale.Settings.Sync.Backup.Failed,
      );
    } catch (e) {
      console.error("[Backup] create failed", e);
      showToast(
        Locale.Settings.Sync.Backup.FailedWithReason(
          (e as any)?.message ?? String(e),
        ),
      );
    } finally {
      setBusy(false);
    }
  };

  const swap = async (id: string) => {
    if (!(await showConfirm(Locale.Settings.Sync.Backup.SwapConfirm))) return;

    try {
      const record = await getBackup(id);
      if (!record) {
        showToast(Locale.Settings.Sync.Backup.Missing);
        return;
      }

      // 先把当前内容记下来（等会儿放到列表最前面），再应用备份
      const current = getLocalAppState();
      const backupState = parseBackup(record);

      const partial: Record<string, any> = {};
      [StoreKey.Chat, StoreKey.Prompt, StoreKey.Mask].forEach((key) => {
        if (backupState?.[key] !== undefined) partial[key] = backupState[key];
      });
      // 只恢复内容类数据，不动 API Key / 设置
      setLocalAppState(partial as any);

      // 被交换的那份从列表里移除，当前内容推到最前面 → 再点一次就能换回来
      await replaceBackupWithCurrent(id, current, "swap", limit);
      await refresh();
      showToast(Locale.Settings.Sync.Backup.SwapDone);
    } catch (e) {
      console.error("[Backup] swap failed", e);
      showToast(Locale.Settings.Sync.Backup.Failed);
    }
  };

  return (
    <List>
      <ListItem
        title={Locale.Settings.Sync.Backup.Title(limit, backups.length)}
        subTitle={Locale.Settings.Sync.Backup.SubTitle}
      >
        <div style={{ display: "flex" }}>
          <IconButton
            icon={<AddIcon />}
            text={
              busy
                ? Locale.Settings.Sync.Backup.Working
                : Locale.Settings.Sync.Backup.Create
            }
            disabled={busy}
            onClick={() => void backupNow()}
          />
        </div>
      </ListItem>

      <ListItem
        title={Locale.Settings.Sync.Backup.LimitTitle(limit)}
        subTitle={Locale.Settings.Sync.Backup.LimitSubTitle(
          MIN_BACKUP_LIMIT,
          MAX_BACKUP_LIMIT,
        )}
      >
        <input
          type="range"
          min={MIN_BACKUP_LIMIT}
          max={MAX_BACKUP_LIMIT}
          step={1}
          value={limit}
          onChange={(e) => {
            // 只改上限，不立刻删：已经超出上限的备份留到下次新建时再清理，
            // 避免调小滑块就把刚存好的备份直接抹掉。
            const value = Number(e.currentTarget.value) || limit;
            syncStore.setBackupLimit(value);
          }}
        />
      </ListItem>

      {backups.map((backup) => (
        <ListItem
          key={backup.id}
          title={formatTime(backup.time)}
          subTitle={Locale.Settings.Sync.Backup.ItemInfo(
            kindLabel(backup.kind),
            backup.sessions,
            Math.round(backup.bytes / 1024),
          )}
        >
          <div style={{ display: "flex" }}>
            <IconButton
              text={Locale.Settings.Sync.Backup.Swap}
              onClick={() => void swap(backup.id)}
            />
          </div>
        </ListItem>
      ))}
    </List>
  );
}
