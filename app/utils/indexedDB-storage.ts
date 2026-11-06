import { StateStorage } from "zustand/middleware";
import { get, set, del, clear } from "idb-keyval";
import { safeLocalStorage } from "@/app/utils";

const localStorage = safeLocalStorage();

class IndexedDBStorage implements StateStorage {
  /**
   * 已经完成 hydration 的 store 名字。
   *
   * 以前这里是 `JSON.parse(value)` 取 `_hasHydrated` —— 聊天状态几 MB，
   * 而每次 set（流式输出时每秒几十次）都要付一次全量解析的钱。
   * 现在由 createPersistStore 在 hydration 完成时打标记，零解析。
   */
  private hydrated = new Set<string>();

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
    try {
      if (!this.hydrated.has(name)) {
        // hydration 还没完成就写，会把默认状态盖到已存的备份上
        console.warn("skip setItem", name);
        return;
      }
      await set(name, value);
    } catch (error) {
      localStorage.setItem(name, value);
    }
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
