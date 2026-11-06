import { StateStorage } from "zustand/middleware";
import { get, set, del, clear } from "idb-keyval";
import { safeLocalStorage } from "@/app/utils";

const localStorage = safeLocalStorage();

/** 写盘合并窗口：流式输出时每秒会触发几十次 set，没必要每次都整包写 */
const WRITE_DELAY = 500;

class IndexedDBStorage implements StateStorage {
  /**
   * 已经完成 hydration 的 store 名字。
   *
   * 以前这里是 `JSON.parse(value)` 取 `_hasHydrated` —— 聊天状态几 MB，
   * 而每次 set（流式输出时每秒几十次）都要付一次全量解析的钱。
   * 现在由 createPersistStore 在 hydration 完成时打标记，零解析。
   */
  private hydrated = new Set<string>();

  /** 待写入的最新值（同一个 store 只保留最后一份，避免堆积） */
  private pending = new Map<string, string>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  public markHydrated(name: string) {
    this.hydrated.add(name);
  }

  public async getItem(name: string): Promise<string | null> {
    try {
      const value = (await get(name)) || localStorage.getItem(name);
      return value;
    } catch (error) {
      return localStorage.getItem(name);
    }
  }

  public async setItem(name: string, value: string): Promise<void> {
    if (!this.hydrated.has(name)) {
      // hydration 还没完成就写，会把默认状态盖到已存的备份上
      console.warn("skip setItem", name);
      return;
    }

    this.pending.set(name, value);
    if (this.timers.has(name)) {
      return;
    }

    this.timers.set(
      name,
      setTimeout(() => this.flush(name), WRITE_DELAY),
    );
  }

  /** 立刻把缓冲的写入落盘（页面隐藏 / 关闭前调用） */
  public flushAll() {
    for (const name of Array.from(this.pending.keys())) {
      this.flush(name);
    }
  }

  private flush(name: string) {
    const timer = this.timers.get(name);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(name);
    }

    const value = this.pending.get(name);
    if (value === undefined) {
      return;
    }
    this.pending.delete(name);

    set(name, value).catch((error) => {
      console.warn(
        "[Storage] failed to write, fallback to localStorage",
        error,
      );
      try {
        localStorage.setItem(name, value);
      } catch (e) {
        console.error("[Storage] failed to write to localStorage too", e);
      }
    });
  }

  public async removeItem(name: string): Promise<void> {
    try {
      await del(name);
    } catch (error) {
      localStorage.removeItem(name);
    }
  }

  public async clear(): Promise<void> {
    try {
      await clear();
    } catch (error) {
      localStorage.clear();
    }
  }
}

export const indexedDBStorage = new IndexedDBStorage();

// 页面被切到后台 / 关闭前，把还没落盘的改动写完，避免丢最后几条消息
if (typeof window !== "undefined") {
  const flush = () => indexedDBStorage.flushAll();

  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      flush();
    }
  });
}
