import { StoreKey } from "../app/constant";
import {
  briefOf,
  buildSyncedHashes,
  mergeByChoices,
  planSync,
  sessionHash,
} from "../app/utils/sync-merge";

function makeSession(id: string, topic: string, content: string, time = 1) {
  return {
    id,
    topic,
    lastUpdate: time,
    messages: [
      { id: `${id}-u`, role: "user", content },
      { id: `${id}-a`, role: "assistant", content: `re: ${content}` },
    ],
  };
}

function makeState(sessions: any[]) {
  return {
    [StoreKey.Chat]: { sessions, currentSessionIndex: 0 },
    [StoreKey.Prompt]: { prompts: {} },
    [StoreKey.Mask]: { masks: {} },
    [StoreKey.Config]: { theme: "auto" },
    [StoreKey.Access]: { openaiApiKey: "" },
  } as any;
}

describe("planSync", () => {
  test("classifies local-only / remote-only / identical sessions", () => {
    const shared = makeSession("s1", "shared", "hi");
    const local = makeState([shared, makeSession("s2", "local", "only local")]);
    const remote = makeState([
      shared,
      makeSession("s3", "remote", "only remote"),
    ]);

    const plan = planSync(local, remote, buildSyncedHashes([shared]));

    expect(plan.identical).toEqual(["s1"]);
    expect(plan.localOnly).toEqual(["s2"]);
    expect(plan.remoteOnly).toEqual(["s3"]);
    expect(plan.conflicts).toHaveLength(0);
  });

  test("one side changed → no conflict", () => {
    const base = makeSession("s1", "t", "base");
    const synced = buildSyncedHashes([base]);

    // 只有本地改了
    const local = makeState([makeSession("s1", "t", "base + local edit", 2)]);
    const remote = makeState([base]);
    let plan = planSync(local, remote, synced);
    expect(plan.localChanged).toEqual(["s1"]);
    expect(plan.conflicts).toHaveLength(0);

    // 只有云端改了
    plan = planSync(makeState([base]), local, synced);
    expect(plan.remoteChanged).toEqual(["s1"]);
    expect(plan.conflicts).toHaveLength(0);
  });

  test("both sides changed → conflict with briefs", () => {
    const base = makeSession("s1", "topic-a", "base");
    const synced = buildSyncedHashes([base]);

    const local = makeState([makeSession("s1", "topic-a", "local edit", 2)]);
    const remote = makeState([makeSession("s1", "topic-a", "remote edit", 3)]);

    const plan = planSync(local, remote, synced);
    expect(plan.conflicts).toHaveLength(1);

    const conflict = plan.conflicts[0];
    expect(conflict.id).toBe("s1");
    expect(conflict.local.lastUser).toBe("local edit");
    expect(conflict.remote.lastUser).toBe("remote edit");
    expect(conflict.local.lastAssistant).toBe("re: local edit");
    expect(conflict.remote.messageCount).toBe(2);
  });

  test("without a baseline the newer lastUpdate wins instead of conflicting", () => {
    const local = makeState([makeSession("s1", "t", "local", 5)]);
    const remote = makeState([makeSession("s1", "t", "remote", 1)]);

    const plan = planSync(local, remote, {});
    expect(plan.conflicts).toHaveLength(0);
    expect(plan.localChanged).toEqual(["s1"]);
  });
});

describe("mergeByChoices", () => {
  test("keeps local by default and applies remote choices", () => {
    const base = makeSession("s1", "t", "base");
    const synced = buildSyncedHashes([base]);

    const local = makeState([
      makeSession("s1", "t", "local edit", 2),
      makeSession("s2", "local only", "x", 3),
    ]);
    const remote = makeState([
      makeSession("s1", "t", "remote edit", 4),
      makeSession("s3", "remote only", "y", 5),
    ]);

    const plan = planSync(local, remote, synced);

    // 默认：冲突保留本地
    const keepLocal = mergeByChoices(local, remote, plan, {});
    const ids = keepLocal.state[StoreKey.Chat].sessions.map((s: any) => s.id);
    expect(ids).toContain("s1");
    expect(ids).toContain("s2");
    expect(ids).toContain("s3");
    const s1 = keepLocal.state[StoreKey.Chat].sessions.find(
      (s: any) => s.id === "s1",
    ) as any;
    expect(s1.messages[0].content).toBe("local edit");

    // 选择云端：同一个会话换成云端那一份
    const useRemote = mergeByChoices(local, remote, plan, { s1: "remote" });
    const remoteS1 = useRemote.state[StoreKey.Chat].sessions.find(
      (s: any) => s.id === "s1",
    ) as any;
    expect(remoteS1.messages[0].content).toBe("remote edit");

    // 合并结果里每个会话都在，且 hash 与内容一致
    expect(useRemote.syncedHashes.s1).toBe(sessionHash(remoteS1));
  });

  test("merges prompts and masks with local priority", () => {
    const local = makeState([]);
    const remote = makeState([]);
    local[StoreKey.Prompt].prompts = {
      a: { id: "a", name: "local" },
      b: { id: "b" },
    };
    remote[StoreKey.Prompt].prompts = {
      a: { id: "a", name: "remote" },
      c: { id: "c" },
    };
    local[StoreKey.Mask].masks = { m1: { id: "m1", name: "local" } };
    remote[StoreKey.Mask].masks = { m2: { id: "m2" } };

    const plan = planSync(local, remote, {});
    const { state } = mergeByChoices(local, remote, plan, {});

    expect((state[StoreKey.Prompt].prompts as any).a.name).toBe("local");
    expect((state[StoreKey.Prompt].prompts as any).c).toBeTruthy();
    expect((state[StoreKey.Mask].masks as any).m1.name).toBe("local");
    expect((state[StoreKey.Mask].masks as any).m2).toBeTruthy();
  });
});

describe("briefOf", () => {
  test("takes the last user / assistant message", () => {
    const session = {
      id: "s",
      topic: "t",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "answer" },
        { role: "user", content: "second" },
      ],
    };
    const brief = briefOf(session);
    expect(brief.lastUser).toBe("second");
    expect(brief.lastAssistant).toBe("answer");
    expect(brief.messageCount).toBe(3);
  });
});
