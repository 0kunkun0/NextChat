import { StoreKey } from "../app/constant";
import {
  buildBackupRecord,
  parseBackup,
  saveBackup,
} from "../app/utils/backup";

describe("local backup", () => {
  test("builds a record with time, session count and size", () => {
    const state = {
      [StoreKey.Chat]: {
        sessions: [{ id: "a" }, { id: "b" }, { id: "c" }],
        currentSessionIndex: 0,
      },
      [StoreKey.Config]: { theme: "dark" },
    };

    const record = buildBackupRecord(state as any, 1234);

    expect(record.time).toBe(1234);
    expect(record.sessions).toBe(3);
    expect(record.bytes).toBeGreaterThan(0);
    // 完整状态都在里面（配置也存了，但恢复时只会用内容类数据）
    expect(parseBackup(record)).toEqual(state);
  });

  test("handles states without chat sessions", () => {
    const record = buildBackupRecord({} as any, 1);
    expect(record.sessions).toBe(0);
    expect(parseBackup(record)).toEqual({});
  });

  test("saveBackup degrades gracefully without IndexedDB", async () => {
    // jsdom 默认没有 indexedDB：不能抛错，返回 null 即可
    const original = (globalThis as any).indexedDB;
    delete (globalThis as any).indexedDB;
    try {
      const record = await saveBackup("manual", { a: 1 });
      expect(record).toBeNull();
    } finally {
      if (original !== undefined) (globalThis as any).indexedDB = original;
    }
  });
});
