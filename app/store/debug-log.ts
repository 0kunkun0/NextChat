import { create } from "zustand";
import { createStore, get, set as idbSet, del } from "idb-keyval";
import { gzipSync, gunzipSync, strToU8, strFromU8 } from "fflate";

/**
 * 前端调试日志。
 *
 * 打开后劫持 console.*，把输出写到 IndexedDB：
 * - 写入时就 gzip 压缩（一两 KB 的日志压完通常只剩几百字节）；
 * - 总量超过 10MB 时自动丢弃最旧的日志块，保证不会把本地存储吃满；
 * - 只有前端逻辑，不涉及任何后端 / 同步。
 */

const META_KEY = "meta";
const ENABLED_KEY = "debug-log-enabled";

/**
 * idb-keyval 的 createStore 需要 indexedDB 存在。
 * 有些环境（隐私模式、被禁用、测试环境）根本没有 —— 那就在模块加载时
 * 直接跳过，不能让整个 store 导入即崩。
 */
let logStore: ReturnType<typeof createStore> | null = null;
function getLogStore() {
  if (logStore) return logStore;
  if (typeof indexedDB === "undefined") return null;
  logStore = createStore("nextchat-debug-log", "chunks");
  return logStore;
}

/** 单条日志最多保留多少字符（避免把巨大的对象整个存进去） */
const MAX_ENTRY_CHARS = 2000;
/** 本地日志上限 */
export const MAX_LOG_BYTES = 10 * 1024 * 1024;
/** 丢弃旧日志后回落到这个大小以下 */
const TRIM_TARGET_BYTES = 8 * 1024 * 1024;
/** 攒一批再写，避免每条日志都触发一次 IDB 事务 */
const FLUSH_DELAY = 800;

export type DebugLogLevel = "log" | "info" | "warn" | "error" | "debug";

export type DebugLogEntry = {
  /** 全局递增序号 */
  seq: number;
  /** 时间戳（毫秒） */
  time: number;
  level: DebugLogLevel;
  text: string;
};

type ChunkMeta = {
  key: string;
  /** 压缩后的大小 */
  bytes: number;
  entries: number;
};

type LogMeta = {
  seq: number;
  bytes: number;
  entries: number;
  chunks: ChunkMeta[];
  /** 因为超限被丢弃的日志条数 */
  dropped: number;
};

const EMPTY_META: LogMeta = {
  seq: 0,
  bytes: 0,
  entries: 0,
  chunks: [],
  dropped: 0,
};

/**
 * 序号从当前时间戳开始往上加，而不是从 1 开始。
 *
 * 日志是持久化的：如果每次刷新都从 1 重新计数，新日志会和上次会话里
 * 序号相同的旧日志撞上（React 列表里就成了重复 key）。
 */
let nextSeq = Date.now();
let buffer: DebugLogEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;
let installed = false;
/** 防递归：日志系统自己写日志时不要再进缓冲区 */
let recording = false;

const originalConsole: Partial<
  Record<DebugLogLevel, (...args: any[]) => void>
> = {};

function readEnabled() {
  try {
    return window.localStorage.getItem(ENABLED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeEnabled(enabled: boolean) {
  try {
    window.localStorage.setItem(ENABLED_KEY, enabled ? "1" : "0");
  } catch {
    // 隐私模式写不进去，当前会话内生效即可
  }
}

/** 把 console 的参数压成一行文本 */
function formatArgs(args: unknown[]) {
  const text = args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      if (arg instanceof Error)
        return arg.stack || `${arg.name}: ${arg.message}`;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ");

  return text.length > MAX_ENTRY_CHARS
    ? text.slice(0, MAX_ENTRY_CHARS) + "…"
    : text;
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, FLUSH_DELAY);
}

/** 把缓冲区写成一个压缩块，并在超限时清理旧块 */
export async function flush() {
  if (flushing || buffer.length === 0) return;

  const store = getLogStore();
  // 没有 IndexedDB：日志只留在内存里（仍然能被查看组件读到缓冲区内未落盘的部分）
  if (!store) return;

  flushing = true;

  const entries = buffer;
  buffer = [];

  try {
    const meta = (await get<LogMeta>(META_KEY, store)) ?? { ...EMPTY_META };
    const key = `c${meta.seq++}`;
    const gz = gzipSync(strToU8(JSON.stringify(entries)));
    await idbSet(key, gz, store);

    meta.chunks.push({ key, bytes: gz.byteLength, entries: entries.length });
    meta.bytes += gz.byteLength;
    meta.entries += entries.length;

    // 超过上限：从最旧的块开始丢，直到回落到目标大小
    while (meta.bytes > MAX_LOG_BYTES && meta.chunks.length > 1) {
      const oldest = meta.chunks.shift()!;
      await del(oldest.key, store).catch(() => {});
      meta.bytes -= oldest.bytes;
      meta.entries -= oldest.entries;
      meta.dropped += oldest.entries;
    }

    // 单块就超过目标大小（短时间内疯狂刷日志）：直接不清，交给下次判断
    if (meta.bytes > TRIM_TARGET_BYTES && meta.chunks.length > 1) {
      while (meta.bytes > TRIM_TARGET_BYTES && meta.chunks.length > 1) {
        const oldest = meta.chunks.shift()!;
        await del(oldest.key, store).catch(() => {});
        meta.bytes -= oldest.bytes;
        meta.entries -= oldest.entries;
        meta.dropped += oldest.entries;
      }
    }

    await idbSet(META_KEY, meta, store);
  } catch (e) {
    // 写不进去就算了，别影响主流程
  } finally {
    flushing = false;
  }
}

function record(level: DebugLogLevel, args: unknown[]) {
  if (recording) return;
  recording = true;
  try {
    buffer.push({
      seq: nextSeq++,
      time: Date.now(),
      level,
      text: formatArgs(args),
    });
    // 缓冲太大就先落盘，避免长时间生成时内存堆积
    if (buffer.length >= 200) {
      void flush();
    } else {
      scheduleFlush();
    }
  } finally {
    recording = false;
  }
}

/** 页面被隐藏 / 关闭前把缓冲区的日志落盘，避免丢最后几条 */
let hideHookInstalled = false;
function installFlushOnHide() {
  if (hideHookInstalled || typeof window === "undefined") return;
  hideHookInstalled = true;

  const flushNow = () => {
    void flush();
  };

  window.addEventListener("pagehide", flushNow);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushNow();
  });
}

export function installConsoleHook() {
  if (installed || typeof window === "undefined") return;
  installed = true;

  (["log", "info", "warn", "error", "debug"] as const).forEach((level) => {
    originalConsole[level] = console[level];
    console[level] = (...args: any[]) => {
      try {
        record(level, args);
      } catch {
        // 记录失败不能影响正常输出
      }
      originalConsole[level]?.apply(console, args);
    };
  });
}

export function uninstallConsoleHook() {
  if (!installed) return;
  installed = false;

  (Object.keys(originalConsole) as DebugLogLevel[]).forEach((level) => {
    const fn = originalConsole[level];
    if (fn) console[level] = fn;
  });
}

/** 读取最近的日志（新的在前），懒加载：只读需要的那几个块 */
export async function loadLogs(limit = 200) {
  const store = getLogStore();
  if (!store)
    return { entries: [] as DebugLogEntry[], meta: { ...EMPTY_META } };

  try {
    const meta = (await get<LogMeta>(META_KEY, store)) ?? { ...EMPTY_META };
    const result: DebugLogEntry[] = [];

    for (let i = meta.chunks.length - 1; i >= 0 && result.length < limit; i--) {
      const chunk = meta.chunks[i];
      try {
        const gz = await get<Uint8Array>(chunk.key, store);
        if (!gz) continue;
        const entries = JSON.parse(
          strFromU8(gunzipSync(gz)),
        ) as DebugLogEntry[];
        // 块内是正序，这里从后往前取
        for (let j = entries.length - 1; j >= 0 && result.length < limit; j--) {
          result.push(entries[j]);
        }
      } catch {
        // 坏块跳过
      }
    }

    return { entries: result, meta };
  } catch {
    // IndexedDB 不可用（隐私模式 / 老浏览器）
    return { entries: [] as DebugLogEntry[], meta: { ...EMPTY_META } };
  }
}

export async function getLogStats() {
  const store = getLogStore();
  if (!store) return { bytes: 0, entries: 0, chunks: 0, dropped: 0 };

  try {
    const meta = (await get<LogMeta>(META_KEY, store)) ?? { ...EMPTY_META };
    return {
      bytes: meta.bytes,
      entries: meta.entries,
      chunks: meta.chunks.length,
      dropped: meta.dropped,
    };
  } catch {
    return { bytes: 0, entries: 0, chunks: 0, dropped: 0 };
  }
}

export async function clearLogs() {
  buffer = [];
  const store = getLogStore();
  if (!store) return;

  try {
    const meta = (await get<LogMeta>(META_KEY, store)) ?? { ...EMPTY_META };
    await Promise.all(
      meta.chunks.map((c) => del(c.key, store).catch(() => {})),
    );
    await del(META_KEY, store).catch(() => {});
  } catch {
    // 忽略
  }
}

type DebugLogState = {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
  /** App 启动时调用：把上次打开过的状态恢复回来 */
  init: () => void;
};

export const useDebugLogStore = create<DebugLogState>((set, get) => ({
  enabled: typeof window === "undefined" ? false : readEnabled(),

  setEnabled(enabled: boolean) {
    writeEnabled(enabled);
    set({ enabled });
    if (enabled) {
      installConsoleHook();
    } else {
      uninstallConsoleHook();
    }
  },

  init() {
    installFlushOnHide();
    if (get().enabled) installConsoleHook();
  },
}));
