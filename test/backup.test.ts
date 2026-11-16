import { StoreKey } from "../app/constant";
import {
  DEFAULT_BACKUP_LIMIT,
  MAX_BACKUP_LIMIT,
  MIN_BACKUP_LIMIT,
  buildBackupRecord,
  clampBackupLimit,
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

    const record = buildBackupRecord(state as any, "manual", 1234);

    expect(record.time).toBe(1234);
    expect(record.kind).toBe("manual");
    expect(record.sessions).toBe(3);
    expect(record.bytes).toBeGreaterThan(0);
    expect(record.id).toBeTruthy();
    // 完整状态都在里面（配置也存了，但恢复时只会用内容类数据）
    expect(parseBackup(record)).toEqual(state);
  });

  test("handles states without chat sessions", () => {
    const record = buildBackupRecord({} as any, "auto", 1);
    expect(record.sessions).toBe(0);
    expect(parseBackup(record)).toEqual({});
  });

  test("每个备份都有独立的 id", () => {
    const a = buildBackupRecord({ a: 1 } as any);
    const b = buildBackupRecord({ a: 1 } as any);
    expect(a.id).not.toBe(b.id);
  });

  test("limit is clamped to [2, 32]", () => {
    expect(clampBackupLimit(1)).toBe(MIN_BACKUP_LIMIT);
    expect(clampBackupLimit(999)).toBe(MAX_BACKUP_LIMIT);
    expect(clampBackupLimit(7)).toBe(7);
    expect(clampBackupLimit(undefined)).toBe(DEFAULT_BACKUP_LIMIT);
    expect(clampBackupLimit(NaN)).toBe(DEFAULT_BACKUP_LIMIT);
  });

  test("saveBackup degrades gracefully without IndexedDB", async () => {
    // jsdom 默认没有 indexedDB：不能抛错，返回 null 即可
    const original = (globalThis as any).indexedDB;
    delete (globalThis as any).indexedDB;
    try {
      const record = await saveBackup({ a: 1 }, "manual");
      expect(record).toBeNull();
    } finally {
      if (original !== undefined) (globalThis as any).indexedDB = original;
    }
  });
});
