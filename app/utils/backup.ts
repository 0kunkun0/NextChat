import { createStore, del, get, set } from "idb-keyval";
import { StoreKey } from "../constant";

/**
 * 本地备份（只存在本机 IndexedDB，不参与云同步）。
 *
 * 为什么需要它：
 * 从云端「下载」会用云端数据整体覆盖本地聊天记录，如果本地正在改东西
 * （比如只改了一半的提示词），一次误点就全没了。所以下载前先自动存一份
 * 当前状态；恢复时做成「交换」而不是「回滚」——手滑用备份覆盖了正确内容，
 * 再点一次就换回来了，两个方向都不会丢。
 *
 * 备份不会被主动删除（界面上没有删除按钮），只有「重置所有数据」才会清掉。
 */

const DB_NAME = "nextchat-local-backup";
const STORE_NAME = "slots";

export type BackupSlot = "auto" | "manual";

export interface BackupRecord {
  /** 备份时间 */
  time: number;
  /** JSON.stringify 后的完整应用状态 */
  state: string;
  /** 里面有多少个会话，用于界面展示 */
  sessions: number;
  /** 大致字节数 */
  bytes: number;
}

/**
 * 纯函数：把应用状态打包成备份记录。
 * 抽出来是为了能在没有 IndexedDB 的环境（测试）里验证。
 */
export function buildBackupRecord(
  state: any,
  now: number = Date.now(),
): BackupRecord {
  const json = JSON.stringify(state);
  const sessions = Array.isArray(state?.[StoreKey.Chat]?.sessions)
    ? state[StoreKey.Chat].sessions.length
    : 0;

  return { time: now, state: json, sessions, bytes: json.length };
}

function getBackupStore() {
  if (typeof indexedDB === "undefined") return null;
  try {
    return createStore(DB_NAME, STORE_NAME);
  } catch {
    return null;
  }
}

/** 保存一份备份到指定槽位，返回写入的记录（环境不支持时为 null） */
export async function saveBackup(
  slot: BackupSlot,
  state: any,
): Promise<BackupRecord | null> {
  const store = getBackupStore();
  if (!store) return null;

  const record = buildBackupRecord(state);
  await set(slot, record, store);
  return record;
}

export async function loadBackup(
  slot: BackupSlot,
): Promise<BackupRecord | null> {
  const store = getBackupStore();
  if (!store) return null;
  const record = await get(slot, store);
  return record ?? null;
}

/** 只清元信息，不解析内容 */
export async function loadBackupInfo() {
  const [auto, manual] = await Promise.all([
    loadBackup("auto").catch(() => null),
    loadBackup("manual").catch(() => null),
  ]);
  return {
    auto: auto
      ? { time: auto.time, sessions: auto.sessions, bytes: auto.bytes }
      : null,
    manual: manual
      ? { time: manual.time, sessions: manual.sessions, bytes: manual.bytes }
      : null,
  };
}

/** 重置所有数据时调用：备份也一起清掉 */
export async function clearBackups() {
  const store = getBackupStore();
  if (!store) return;
  await Promise.all([del("auto", store), del("manual", store)]);
}

/** 把 JSON 还原成对象 */
export function parseBackup(record: BackupRecord): any {
  return JSON.parse(record.state);
}
