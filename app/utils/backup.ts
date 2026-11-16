import { createStore, del, get, set } from "idb-keyval";
import { StoreKey } from "../constant";

/**
 * 本地备份（只存在本机 IndexedDB，不参与云同步）。
 *
 * 为什么需要它：
 * 「下载 / 同步」会用云端数据覆盖本地聊天记录，如果本地正在改东西
 * （比如只改了一半的提示词），一次误点就全没了。所以这些操作前都会先
 * 自动存一份；恢复时做成「交换」而不是「回滚」——手滑用备份覆盖了正确
 * 内容，再点一次就换回来了，两个方向都不会丢。
 *
 * 备份是一个列表：可以保留多个时间点，超过上限时自动删除最早的一份。
 * 界面上没有手动删除的入口，只有「重置所有数据」会清空。
 */

const DB_NAME = "nextchat-local-backup";
const STORE_NAME = "backups";
const INDEX_KEY = "index";
const ENTRY_PREFIX = "entry:";

/** 备份来源：手动 / 下载前自动 / 交换产生 */
export type BackupKind = "manual" | "auto" | "swap";

export interface BackupMeta {
  id: string;
  time: number;
  kind: BackupKind;
  /** 里面有多少个会话 */
  sessions: number;
  /** 大致字节数 */
  bytes: number;
}

export interface BackupRecord extends BackupMeta {
  /** JSON.stringify 后的完整应用状态 */
  state: string;
}

export const MIN_BACKUP_LIMIT = 2;
export const MAX_BACKUP_LIMIT = 32;
export const DEFAULT_BACKUP_LIMIT = 5;

export function clampBackupLimit(limit?: number) {
  const value = Number(limit);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_BACKUP_LIMIT;
  return Math.min(
    MAX_BACKUP_LIMIT,
    Math.max(MIN_BACKUP_LIMIT, Math.round(value)),
  );
}

function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 备份列表变化的订阅：同步 / 下载在别的组件里存了备份时，
 * 备份列表界面要能立刻刷新。
 */
const listeners = new Set<() => void>();

export function onBackupsChanged(callback: () => void) {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

function notifyChanged() {
  listeners.forEach((callback) => {
    try {
      callback();
    } catch {
      // 单个订阅者出错不影响其他人
    }
  });
}

/**
 * 纯函数：把应用状态打包成备份记录。
 * 抽出来是为了能在没有 IndexedDB 的环境（测试）里验证。
 */
export function buildBackupRecord(
  state: any,
  kind: BackupKind = "manual",
  now: number = Date.now(),
): BackupRecord {
  const json = JSON.stringify(state);
  const sessions = Array.isArray(state?.[StoreKey.Chat]?.sessions)
    ? state[StoreKey.Chat].sessions.length
    : 0;

  return {
    id: newId(),
    time: now,
    kind,
    sessions,
    bytes: json.length,
    state: json,
  };
}

function getBackupStore() {
  if (typeof indexedDB === "undefined") return null;
  try {
    return createStore(DB_NAME, STORE_NAME);
  } catch {
    return null;
  }
}

type BackupStore = NonNullable<ReturnType<typeof getBackupStore>>;

async function readIndex(store: BackupStore): Promise<BackupMeta[]> {
  const list = await get<BackupMeta[]>(INDEX_KEY, store);
  return Array.isArray(list) ? list : [];
}

const toMeta = (record: BackupRecord): BackupMeta => ({
  id: record.id,
  time: record.time,
  kind: record.kind,
  sessions: record.sessions,
  bytes: record.bytes,
});

/** 写入列表并按上限裁剪（超出部分删除最旧的，连同内容） */
async function commit(store: BackupStore, list: BackupMeta[], limit: number) {
  const max = clampBackupLimit(limit);
  const sorted = [...list].sort((a, b) => b.time - a.time);
  const dropped = sorted.splice(max);
  await Promise.all(
    dropped.map((m) => del(`${ENTRY_PREFIX}${m.id}`, store)),
  ).catch(() => undefined);
  await set(INDEX_KEY, sorted, store);
  notifyChanged();
  return sorted;
}

/** 读取备份列表（按时间倒序，最新的在前），不含内容 */
export async function listBackups(): Promise<BackupMeta[]> {
  const store = getBackupStore();
  if (!store) return [];
  try {
    const list = await readIndex(store);
    return [...list].sort((a, b) => b.time - a.time);
  } catch {
    return [];
  }
}

/** 保存一份新备份到列表最前面，并裁剪到上限 */
export async function saveBackup(
  state: any,
  kind: BackupKind,
  limit: number = DEFAULT_BACKUP_LIMIT,
): Promise<BackupRecord | null> {
  const store = getBackupStore();
  if (!store) return null;

  const record = buildBackupRecord(state, kind);
  await set(`${ENTRY_PREFIX}${record.id}`, record, store);

  const list = await readIndex(store);
  await commit(
    store,
    [toMeta(record), ...list.filter((m) => m.id !== record.id)],
    limit,
  );
  return record;
}

export async function getBackup(id: string): Promise<BackupRecord | null> {
  const store = getBackupStore();
  if (!store) return null;
  try {
    return (await get<BackupRecord>(`${ENTRY_PREFIX}${id}`, store)) ?? null;
  } catch {
    return null;
  }
}

/**
 * 交换用：把被交换的那份从列表里去掉，把「当前内容」放到最前面。
 * 这样交换之后总份数不变，而且当前内容随时能再换回来。
 */
export async function replaceBackupWithCurrent(
  id: string,
  state: any,
  kind: BackupKind = "swap",
  limit: number = DEFAULT_BACKUP_LIMIT,
): Promise<BackupRecord | null> {
  const store = getBackupStore();
  if (!store) return null;

  const list = await readIndex(store);
  await del(`${ENTRY_PREFIX}${id}`, store).catch(() => undefined);

  const record = buildBackupRecord(state, kind);
  await set(`${ENTRY_PREFIX}${record.id}`, record, store);

  await commit(
    store,
    [toMeta(record), ...list.filter((m) => m.id !== id && m.id !== record.id)],
    limit,
  );
  return record;
}

/** 按上限裁剪（比如用户把滑块从 8 调到 3 之后） */
export async function trimBackups(limit: number): Promise<BackupMeta[]> {
  const store = getBackupStore();
  if (!store) return [];

  const list = await readIndex(store);
  return commit(store, list, limit);
}

/** 重置所有数据时调用：备份也一起清掉 */
export async function clearBackups() {
  const store = getBackupStore();
  if (!store) return;
  try {
    const list = await readIndex(store);
    await Promise.all(list.map((m) => del(`${ENTRY_PREFIX}${m.id}`, store)));
    await del(INDEX_KEY, store);
    notifyChanged();
  } catch {
    // 清不掉也不影响主流程
  }
}

/** 把 JSON 还原成对象 */
export function parseBackup(record: BackupRecord): any {
  return JSON.parse(record.state);
}
