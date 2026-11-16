import { createStore, del, get, set } from "idb-keyval";
import { gzipSync, gunzipSync, strToU8, strFromU8 } from "fflate";
import { StoreKey } from "../constant";

/** Uint8Array → base64（分块处理，避免大数组触发 apply 参数上限） */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + CHUNK)) as any,
    );
  }
  return btoa(binary);
}

function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

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
/**
 * ⚠️ 这里必须沿用老库里的 store 名 "slots"。
 *
 * idb-keyval 的 createStore 只在**数据库第一次创建时**建 store；
 * 如果数据库已经存在（老版本建过 "slots"），再换一个名字去开事务，
 * 就会报 `One of the specified object stores was not found`。
 * 所以 store 名保持不变，改在 store 内部换 key 布局（老数据会被迁移）。
 */
const STORE_NAME = "slots";
const INDEX_KEY = "index";
const ENTRY_PREFIX = "entry:";
/** 老版本用的是两个固定槽位 key，迁移时会转成列表项 */
const LEGACY_SLOT_KEYS = ["auto", "manual"] as const;

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
  /**
   * 备份内容。
   * 新写入的是 **gzip 压缩后的 base64**（gz = true）：
   * 完整状态 JSON 动辄 5~6MB，移动端 Safari 的 IndexedDB 配额有限，
   * 存几份未压缩的就会写失败（表现就是“点了没反应”）。
   * 老记录没有 gz 标记，按明文 JSON 处理。
   */
  state: string;
  gz?: boolean;
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
 *
 * 内容会 gzip 压缩后再存：未压缩的 5~6MB JSON 在移动端浏览器里
 * 很容易把 IndexedDB 写失败（点「立即备份」没反应就是这个原因）。
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

  const compressed = bytesToBase64(gzipSync(strToU8(json)));

  return {
    id: newId(),
    time: now,
    kind,
    sessions,
    bytes: compressed.length,
    state: compressed,
    gz: true,
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

/**
 * 确保数据库里确实有我们要的 store。
 *
 * idb-keyval 的 createStore 不会“补建”store：数据库已存在但它要的 store
 * 不存在时，事务会直接报 `One of the specified object stores was not found`。
 * 所以这里自己用带版本号的 open 兜底，缺哪个补哪个（历史上出现过 "slots"
 * 和 "backups" 两个名字，两个都确保存在）。
 */
const DB_VERSION = 2;
const LEGACY_STORE_NAME = "backups";

let dbPromise: Promise<void> | null = null;

function ensureDb(): Promise<void> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<void>((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        [STORE_NAME, LEGACY_STORE_NAME].forEach((name) => {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
        });
      };
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });

  return dbPromise;
}

/** 拿到可用 store（顺带确保数据库结构就绪） */
async function ready(): Promise<BackupStore | null> {
  const store = getBackupStore();
  if (!store) return null;
  await ensureDb().catch(() => undefined);
  return store;
}

type BackupStore = NonNullable<ReturnType<typeof getBackupStore>>;

/**
 * 迁移老版本的「固定槽位」备份（auto / manual）到新的列表结构。
 *
 * 只在没有 index 时执行一次：把老记录转成列表项、补上 id，然后删掉旧 key。
 * 老记录的 state 是明文 JSON（没有 gz 标记），parseBackup 仍然能读。
 */
async function migrateLegacySlots(store: BackupStore): Promise<BackupMeta[]> {
  const legacy: BackupMeta[] = [];

  for (const key of LEGACY_SLOT_KEYS) {
    let record: any = null;
    try {
      record = await get(key, store);
    } catch {
      record = null;
    }
    if (!record || typeof record.state !== "string") continue;

    const meta: BackupRecord = {
      id: `${key}-${record.time ?? Date.now()}`,
      time: Number(record.time) || Date.now(),
      kind: key === "auto" ? "auto" : "manual",
      sessions: Number(record.sessions) || 0,
      bytes: Number(record.bytes) || 0,
      // 老记录没有 gz 标记 → 明文 JSON
      state: record.state,
    };

    try {
      await set(`${ENTRY_PREFIX}${meta.id}`, meta, store);
      await del(key, store);
      legacy.push(toMeta(meta));
    } catch (e) {
      console.warn("[Backup] failed to migrate legacy slot", key, e);
    }
  }

  if (legacy.length > 0) {
    legacy.sort((a, b) => b.time - a.time);
    await set(INDEX_KEY, legacy, store);
    console.log("[Backup] migrated legacy backups:", legacy.length);
  }

  return legacy;
}

/** 读列表；首次调用时顺便把老槽位迁移过来 */
async function readIndex(store: BackupStore): Promise<BackupMeta[]> {
  const list = await get<BackupMeta[]>(INDEX_KEY, store).catch(() => undefined);
  if (Array.isArray(list)) return list;
  return migrateLegacySlots(store);
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
  const store = await ready();
  if (!store) return [];
  try {
    const list = await readIndex(store);
    return [...list].sort((a, b) => b.time - a.time);
  } catch {
    return [];
  }
}

/**
 * 保存一份新备份到列表最前面，并裁剪到上限。
 *
 * 移动端浏览器（尤其 iOS Safari）的 IndexedDB 配额有限，写大字符串可能
 * 直接抛错——这里做一次「先清掉一半旧备份再重试」的兜底，
 * 调用方要负责把异常显示出来，不能静默失败。
 */
export async function saveBackup(
  state: any,
  kind: BackupKind,
  limit: number = DEFAULT_BACKUP_LIMIT,
): Promise<BackupRecord | null> {
  const store = await ready();
  if (!store) return null;

  const record = buildBackupRecord(state, kind);

  const write = async () => {
    const list = await readIndex(store);
    await set(`${ENTRY_PREFIX}${record.id}`, record, store);
    await commit(
      store,
      [toMeta(record), ...list.filter((m) => m.id !== record.id)],
      limit,
    );
  };

  try {
    await write();
  } catch (e) {
    console.warn("[Backup] save failed, trimming old backups and retrying", e);
    // 配额不足：删掉最旧的一半再试一次
    const list = await readIndex(store).catch(() => [] as BackupMeta[]);
    const keep = list.slice(0, Math.ceil(list.length / 2));
    await Promise.all(
      list.slice(keep.length).map((m) => del(`${ENTRY_PREFIX}${m.id}`, store)),
    ).catch(() => undefined);
    await set(INDEX_KEY, keep, store).catch(() => undefined);
    await write();
  }

  return record;
}

export async function getBackup(id: string): Promise<BackupRecord | null> {
  const store = await ready();
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
  const store = await ready();
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
  const store = await ready();
  if (!store) return [];

  const list = await readIndex(store);
  return commit(store, list, limit);
}

/** 重置所有数据时调用：备份也一起清掉 */
export async function clearBackups() {
  const store = await ready();
  if (!store) return;
  try {
    const list = await readIndex(store);
    await Promise.all(
      list.map((m) => del(`${ENTRY_PREFIX}${m.id}`, store)),
    ).catch(() => undefined);
    // 老槽位 key 也一起删掉，避免留下孤儿数据占配额
    await Promise.all(LEGACY_SLOT_KEYS.map((key) => del(key, store))).catch(
      () => undefined,
    );
    await del(INDEX_KEY, store);
    notifyChanged();
  } catch {
    // 清不掉也不影响主流程
  }
}

/** 把备份还原成对象（兼容老的未压缩记录） */
export function parseBackup(record: BackupRecord): any {
  if (record.gz) {
    return JSON.parse(strFromU8(gunzipSync(base64ToBytes(record.state))));
  }
  return JSON.parse(record.state);
}
