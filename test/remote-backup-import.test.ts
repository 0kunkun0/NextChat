import {
  prepareSessionForImport,
  toImportCandidates,
} from "../app/utils/cloud/backup-candidates";

/**
 * 「从数据库导入其它备份」的纯逻辑：候选列表 + 重名处理。
 *
 * 真正的网络读取（SCAN 备份名 / 读取索引 / 解密）需要 Upstash，放在浏览器里跑，
 * 这里只测能从云端会话变成「可勾选列表」和「不会覆盖本地同名会话」这两件事。
 */
function makeSession(
  id: string,
  topic: string,
  messages = 3,
  lastUpdate = 1000,
) {
  return {
    id,
    topic,
    messages: Array.from({ length: messages }, (_, i) => ({
      id: `${id}-m${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `第 ${i} 条`,
      date: new Date(lastUpdate + i).toISOString(),
    })),
    lastUpdate,
  } as any;
}

describe("toImportCandidates", () => {
  test("转换成勾选列表并按更新时间倒序", () => {
    const candidates = toImportCandidates([
      makeSession("a", "旧会话", 5, 1000),
      makeSession("b", "新会话", 2, 5000),
    ]);

    expect(candidates.map((item) => item.exportId)).toEqual(["b", "a"]);
    expect(candidates[0]).toMatchObject({
      title: "新会话",
      messageCount: 2,
      pinned: false,
      updatedAt: 5000,
    });
  });

  test("没有标题时给个占位名", () => {
    const candidates = toImportCandidates([makeSession("x", "")]);
    expect(candidates[0].title).toBe("(无标题)");
  });

  test("结构不对的会话被忽略", () => {
    const candidates = toImportCandidates([
      makeSession("ok", "正常"),
      { id: "bad", topic: "没有 messages" } as any,
      null as any,
    ]);
    expect(candidates.map((item) => item.exportId)).toEqual(["ok"]);
  });

  test("和本地同名时标记 willRename", () => {
    const candidates = toImportCandidates(
      [makeSession("dup", "重复"), makeSession("new", "新的")],
      ["dup"],
    );
    expect(candidates.find((item) => item.exportId === "dup")?.willRename).toBe(
      true,
    );
    expect(candidates.find((item) => item.exportId === "new")?.willRename).toBe(
      false,
    );
  });
});

describe("prepareSessionForImport", () => {
  test("id 不冲突时原样导入", () => {
    const session = makeSession("a", "会话 A");
    const taken = new Set<string>();
    const { session: imported, renamed } = prepareSessionForImport(
      session,
      taken,
    );
    expect(renamed).toBe(false);
    expect(imported.id).toBe("a");
    expect(taken.has("a")).toBe(true);
  });

  test("id 冲突时另存为副本，不覆盖本地会话", () => {
    const session = makeSession("a", "云端版本");
    const taken = new Set<string>(["a"]);
    const { session: imported, renamed } = prepareSessionForImport(
      session,
      taken,
    );

    expect(renamed).toBe(true);
    expect(imported.id).not.toBe("a");
    expect(imported.id.startsWith("a-imported-")).toBe(true);
    expect(imported.topic).toBe("云端版本");
    // 新 id 也要被占用，连续导入两条同 id 的不会互相撞
    expect(taken.has(imported.id)).toBe(true);
  });

  test("同一批里重复 id 会逐个换新 id", () => {
    const taken = new Set<string>();
    const first = prepareSessionForImport(makeSession("a", "一"), taken);
    const second = prepareSessionForImport(makeSession("a", "二"), taken);

    expect(first.renamed).toBe(false);
    expect(second.renamed).toBe(true);
    expect(first.session.id).not.toBe(second.session.id);
  });
});
