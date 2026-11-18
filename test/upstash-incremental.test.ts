import { TextDecoder, TextEncoder } from "util";
import { CompressionStream, DecompressionStream } from "stream/web";
import { StoreKey } from "../app/constant";
import {
  createUpstashClient,
  resolveChunkBytes,
} from "../app/utils/cloud/upstash";

// jsdom 没有这些 Web API，分片 / 压缩逻辑依赖它们
if (typeof globalThis.TextEncoder === "undefined") {
  (globalThis as any).TextEncoder = TextEncoder;
}
if (typeof globalThis.TextDecoder === "undefined") {
  (globalThis as any).TextDecoder = TextDecoder;
}
if (typeof globalThis.CompressionStream === "undefined") {
  (globalThis as any).CompressionStream = CompressionStream;
}
if (typeof globalThis.DecompressionStream === "undefined") {
  (globalThis as any).DecompressionStream = DecompressionStream;
}

function makeSyncStore(
  options: { useCompression?: boolean; chunkSizeKB?: number } = {},
) {
  return {
    provider: "upstash",
    useProxy: false,
    proxyUrl: "",
    useCompression: options.useCompression === true,
    upstash: {
      endpoint: "https://example.upstash.io",
      username: "backup",
      apiKey: "token",
      chunkSizeKB: options.chunkSizeKB ?? 1024,
    },
  } as any;
}

/** 伪造 Upstash REST 接口（get / set / pipeline），数据存在内存 Map 里 */
function installFakeUpstash(
  options: {
    failPipeline?: boolean;
    onWrite?: (key: string) => void;
    /** 模拟写失败（例如单条超限的 413），返回 true 表示这次 SET 要失败 */
    failWrite?: (key: string) => boolean;
    /** 模拟读取失败 */
    failGet?: (key: string) => boolean;
  } = {},
) {
  const kv = new Map<string, string>();
  const writes: string[] = [];
  const gets: string[] = [];
  let pipelineCalls = 0;

  (globalThis as any).fetch = async (url: string, init: any = {}) => {
    if (init.signal?.aborted) {
      const error = new Error("The operation was aborted.");
      error.name = "AbortError";
      throw error;
    }

    const u = new URL(String(url), "http://localhost");
    // 直连（https://xxx.upstash.io/get/key）和走代理（/api/upstash/get/key）两种都要认
    const match =
      u.pathname.match(/^\/api\/upstash\/(get|set|pipeline)\/(.+?)\/?$/) ??
      u.pathname.match(/^\/(get|set|pipeline)(?:\/(.+?))?\/?$/);
    if (!match) throw new Error("unexpected url: " + url);

    const [, action, key] = match;

    const respond = (body: any) =>
      ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => body,
        text: async () => "",
      }) as any;

    if (action === "pipeline") {
      pipelineCalls += 1;
      if (options.failPipeline) {
        return {
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
          json: async () => ({}),
          text: async () => "boom",
        } as any;
      }
      const commands = JSON.parse(String(init.body ?? "[]")) as string[][];
      const results = commands.map((command) => {
        if (command[0] === "SET") {
          kv.set(command[1], command[2]);
          writes.push(command[1]);
          options.onWrite?.(command[1]);
          return { result: "OK" };
        }
        if (command[0] === "DEL") {
          // DEL 支持一次带多个 key（clearRemote 现在就是这么批量删的）
          let count = 0;
          for (const key of command.slice(1)) {
            if (kv.delete(key)) count += 1;
          }
          return { result: count };
        }
        if (command[0] === "EXISTS") {
          // 上传时的自愈校验会用它确认数据还在不在
          return { result: command.slice(1).filter((k) => kv.has(k)).length };
        }
        gets.push(command[1]);
        return { result: kv.has(command[1]) ? kv.get(command[1])! : null };
      });
      return respond(results);
    }

    if (action === "set") {
      if (options.failWrite?.(key)) {
        return {
          ok: false,
          status: 413,
          statusText: "Payload Too Large",
          json: async () => ({}),
          text: async () => "too large",
        } as any;
      }
      kv.set(key, String(init.body ?? ""));
      writes.push(key);
      options.onWrite?.(key);
    } else {
      if (options.failGet?.(key)) {
        return {
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
          json: async () => ({}),
          text: async () => "boom",
        } as any;
      }
      gets.push(key);
    }

    return respond({ result: kv.has(key) ? kv.get(key)! : null });
  };

  return {
    kv,
    writes,
    gets,
    get pipelineCalls() {
      return pipelineCalls;
    },
  };
}

function makeSession(id: string, content: string) {
  return {
    id,
    topic: id,
    messages: [
      { id: `${id}-m1`, role: "user", content, date: "2026/1/1 00:00:00" },
    ],
    mask: {},
    stat: { tokenCount: 0, wordCount: 0, charCount: 0 },
    lastUpdate: 1,
    lastSummarizeIndex: 0,
    memoryPrompt: "",
  };
}

function makeState(s1Content = "hello", s2Content = "world") {
  return {
    [StoreKey.Chat]: {
      sessions: [makeSession("s1", s1Content), makeSession("s2", s2Content)],
      currentSessionIndex: 0,
      lastInput: "",
    },
    [StoreKey.Access]: { openaiApiKey: "key" },
    [StoreKey.Config]: { theme: "auto" },
    [StoreKey.Mask]: { masks: {} },
    [StoreKey.Prompt]: { prompts: {} },
  } as any;
}

function readIndex(server: { kv: Map<string, string> }) {
  return JSON.parse(server.kv.get("backup-v2-index")!);
}

const client = createUpstashClient(makeSyncStore());

describe("upstash incremental upload", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  test("first upload writes every session, store and the index", async () => {
    const server = installFakeUpstash();
    const stats = await client.upload(makeState());

    expect(stats.uploaded).toBe(6); // 2 个会话 + 4 个 store
    expect(stats.skipped).toBe(0);
    expect(server.writes).toContain("backup-v2-s-s1");
    expect(server.writes).toContain("backup-v2-s-s2");
    expect(server.writes).toContain("backup-v2-t-access-control");
    expect(server.writes).toContain("backup-v2-index");
  });

  test("duplicate session ids are collapsed on upload", async () => {
    const server = installFakeUpstash();
    const state = makeState();
    // 同一个 id 出现两次（历史上出现过，会让下载时互相顶掉）
    (state[StoreKey.Chat] as any).sessions = [
      makeSession("dup", "first"),
      makeSession("dup", "second"),
    ];

    await client.upload(state);

    const ids = readIndex(server).sessions.map((s: any) => s.id);
    expect(ids).toEqual(["dup"]);
  });

  test("download keeps the local copy when the remote payload is gone", async () => {
    const server = installFakeUpstash();
    await client.upload(makeState());

    // 云端 s2 的 key 丢了（索引里还有）
    server.kv.delete("backup-v2-s-s2");

    // 本地改过 s2（哈希不同 → 会尝试重新拉取），但本地副本还在
    const local = makeState("hello", "world edited locally");
    const restored = await client.download(local);

    const s2 = (restored as any)[StoreKey.Chat].sessions.find(
      (s: any) => s.id === "s2",
    );
    // 没有直接丢掉，而是用本地副本兜底
    expect(s2).toBeTruthy();
    expect(s2.messages[0].content).toBe("world edited locally");
  });

  test("download recovers a session whose index says chunked but data is a single key", async () => {
    const savedCompression = (globalThis as any).CompressionStream;
    const savedDecompression = (globalThis as any).DecompressionStream;
    delete (globalThis as any).CompressionStream;
    delete (globalThis as any).DecompressionStream;

    try {
      const server = installFakeUpstash();
      const smallChunks = createUpstashClient(
        makeSyncStore({ chunkSizeKB: 16 }),
      );
      const big = "word ".repeat(40_000); // 约 200KB，会被切片
      await smallChunks.upload(makeState(big));

      // 把分片拼回单 key，删掉 -n 和所有分片：模拟“索引说切片、实际是单 key”
      const count = Number(server.kv.get("backup-v2-s-s1-n"));
      expect(count).toBeGreaterThan(1);
      let payload = "";
      for (let i = 0; i < count; i++) {
        payload += server.kv.get(`backup-v2-s-s1-c${i}`) ?? "";
        server.kv.delete(`backup-v2-s-s1-c${i}`);
      }
      server.kv.set("backup-v2-s-s1", payload);
      server.kv.delete("backup-v2-s-s1-n");

      // forceFull 强制真的去读，走 readValue 的回退分支
      const restored = await smallChunks.download(undefined, undefined, {
        forceFull: true,
      });
      expect(
        (restored as any)[StoreKey.Chat].sessions.find(
          (s: any) => s.id === "s1",
        ).messages[0].content,
      ).toBe(big);
    } finally {
      (globalThis as any).CompressionStream = savedCompression;
      (globalThis as any).DecompressionStream = savedDecompression;
    }
  });

  test("upload repairs a session whose cloud data disappeared behind the index", async () => {
    const server = installFakeUpstash();
    const state = makeState();
    // 先正常传一次
    await client.upload(state);

    // 模拟“索引说已同步，但数据 key 被清掉了”
    server.kv.delete("backup-v2-s-s2");

    server.writes.length = 0;
    const stats = await client.upload(makeState());

    // 内容没变，但自愈逻辑应该把它重新写上去
    expect(stats.uploaded).toBe(1);
    expect(server.writes).toContain("backup-v2-s-s2");

    // 现在下载能拿到它了
    const restored = await client.download();
    const s2 = (restored as any)[StoreKey.Chat].sessions.find(
      (s: any) => s.id === "s2",
    );
    expect(s2?.messages[0].content).toBe("world");
  });

  test("second upload only writes the session that changed", async () => {
    const server = installFakeUpstash();
    await client.upload(makeState());

    server.writes.length = 0;
    const stats = await client.upload(makeState("hello, edited"));

    expect(stats.uploaded).toBe(1);
    expect(stats.skipped).toBe(5);
    expect(server.writes).toEqual(["backup-v2-s-s1", "backup-v2-index"]);
  });

  test("sessionIds uploads only that session and keeps the rest of the index", async () => {
    const server = installFakeUpstash();
    await client.upload(makeState());
    const before = readIndex(server);
    expect(before.sessions.map((s: any) => s.id).sort()).toEqual(["s1", "s2"]);

    server.writes.length = 0;
    const stats = await client.upload(makeState("hello, edited"), undefined, {
      sessionIds: ["s1"],
    });

    // 只写了 s1 和索引，其它会话 / 配置一个都没碰
    expect(stats.uploaded).toBe(1);
    expect(server.writes).toEqual(["backup-v2-s-s1", "backup-v2-index"]);

    const after = readIndex(server);
    // 另一条会话的索引条目必须原样保留
    expect(after.sessions.map((s: any) => s.id).sort()).toEqual(["s1", "s2"]);
    expect(after.sessions.find((s: any) => s.id === "s2")).toEqual(
      before.sessions.find((s: any) => s.id === "s2"),
    );
    // 被上传的那条哈希变了
    expect(after.sessions.find((s: any) => s.id === "s1").h).not.toBe(
      before.sessions.find((s: any) => s.id === "s1").h,
    );

    // 内容确实可下载回来
    const restored = await client.download();
    expect(
      restored[StoreKey.Chat].sessions.find((s: any) => s.id === "s1")
        .messages[0].content,
    ).toBe("hello, edited");
  });

  test("sessionIds with unchanged content writes nothing", async () => {
    const server = installFakeUpstash();
    await client.upload(makeState());

    server.writes.length = 0;
    const stats = await client.upload(makeState(), undefined, {
      sessionIds: ["s2"],
    });
    expect(stats.total).toBe(0);
    expect(server.writes).toEqual([]);
  });

  test("reordering sessions (sidebar drag) keeps every session in the cloud", async () => {
    const server = installFakeUpstash();
    const state = makeState();
    await client.upload(state);

    // 模拟侧边栏拖动：只改变顺序，内容不动
    const reordered = makeState();
    (reordered[StoreKey.Chat] as any).sessions = [
      makeSession("s2", "world"),
      makeSession("s1", "hello"),
    ];
    (reordered[StoreKey.Chat] as any).currentSessionIndex = 1;

    server.writes.length = 0;
    await client.upload(reordered);

    // 内容没变，但顺序变了 → 只重写索引（不重传会话数据）
    expect(server.writes).toEqual(["backup-v2-index"]);

    const index = readIndex(server);
    expect(index.sessions.map((s: any) => s.id)).toEqual(["s2", "s1"]);

    // 下载回来两条都在，且内容正确
    const restored = await client.download();
    const sessions = (restored as any)[StoreKey.Chat].sessions;
    expect(sessions.map((s: any) => s.id)).toEqual(["s2", "s1"]);
    expect(sessions.find((s: any) => s.id === "s1").messages[0].content).toBe(
      "hello",
    );
    expect(sessions.find((s: any) => s.id === "s2").messages[0].content).toBe(
      "world",
    );
  });

  test("upload never removes sessions that are missing locally", async () => {
    const server = installFakeUpstash();
    await client.upload(makeState());

    // 本地只剩 s1（例如本地意外丢了一条）：上传不能把云端的 s2 抹掉
    const partial = makeState();
    (partial[StoreKey.Chat] as any).sessions = [makeSession("s1", "hello")];
    await client.upload(partial);

    const index = readIndex(server);
    expect(index.sessions.map((s: any) => s.id).sort()).toEqual(["s1", "s2"]);

    const restored = await client.download();
    const sessions = (restored as any)[StoreKey.Chat].sessions;
    expect(sessions.map((s: any) => s.id).sort()).toEqual(["s1", "s2"]);
    expect(sessions.find((s: any) => s.id === "s2").messages[0].content).toBe(
      "world",
    );
  });

  test("lastInput（输入框草稿）不会写进云端索引", async () => {
    const server = installFakeUpstash();
    const state = makeState();
    (state[StoreKey.Chat] as any).lastInput = "这是还没发出去的草稿";

    await client.upload(state);

    // 索引是明文存储的：草稿绝对不能出现在里面
    const rawIndex = server.kv.get("backup-v2-index")!;
    expect(rawIndex).not.toContain("这是还没发出去的草稿");
    expect(readIndex(server).chat.lastInput).toBeUndefined();
  });

  test("老索引里残留的 lastInput 下载时会被忽略", async () => {
    const server = installFakeUpstash();
    await client.upload(makeState());

    // 手动把 lastInput 塞回索引，模拟旧版本写下的数据
    const index = readIndex(server);
    index.chat = { ...index.chat, lastInput: "旧版本留下的草稿" };
    server.kv.set("backup-v2-index", JSON.stringify(index));

    const local = makeState();
    (local[StoreKey.Chat] as any).lastInput = "本地草稿";

    const restored = await client.download(local);
    // 远端草稿不会被带回来（本地的也不该被清空，这里只验证不覆盖）
    expect((restored as any)[StoreKey.Chat].lastInput).toBeUndefined();
  });

  test("deleteMissing removes sessions that only exist in the cloud", async () => {
    const server = installFakeUpstash();
    await client.upload(makeState());

    // 本地删掉 s2 后，勾选「删除云端已不存在的会话」再上传
    const partial = makeState();
    (partial[StoreKey.Chat] as any).sessions = [makeSession("s1", "hello")];

    const stats = await client.upload(partial, undefined, {
      deleteMissing: true,
    });

    expect(stats.deleted).toBe(1);
    // 索引里只剩 s1，s2 的数据 key 也被删掉
    const index = readIndex(server);
    expect(index.sessions.map((s: any) => s.id)).toEqual(["s1"]);
    expect(server.kv.has("backup-v2-s-s2")).toBe(false);
    expect(server.kv.has("backup-v2-s-s2-n")).toBe(false);
  });

  test("uploading unchanged state writes nothing", async () => {
    const server = installFakeUpstash();
    await client.upload(makeState());

    server.writes.length = 0;
    const stats = await client.upload(makeState());

    expect(stats.total).toBe(0);
    expect(server.writes).toEqual([]);
  });

  test("forceFull re-uploads everything even when nothing changed", async () => {
    const server = installFakeUpstash();
    await client.upload(makeState());

    server.writes.length = 0;
    const stats = await client.upload(makeState(), undefined, {
      forceFull: true,
    });

    // 6 项全部重写 + 索引
    expect(stats.uploaded).toBe(6);
    expect(stats.skipped).toBe(0);
    expect(server.writes).toContain("backup-v2-index");
  });

  test("forceFull download re-fetches sessions that are unchanged", async () => {
    const server = installFakeUpstash();
    const state = makeState();
    await client.upload(state);

    server.gets.length = 0;
    const skipped = await client.download(state);
    expect(skipped).toBeTruthy();
    // 增量下载：内容一致，不读会话本体
    expect(
      server.gets.filter((k) => k.startsWith("backup-v2-s-")),
    ).toHaveLength(0);

    server.gets.length = 0;
    const full = await client.download(state, undefined, { forceFull: true });
    expect(full).toBeTruthy();
    expect(
      server.gets.filter((k) => k.startsWith("backup-v2-s-")).length,
    ).toBeGreaterThan(0);
  });

  test("re-uploads everything when the remote data was wiped", async () => {
    const server = installFakeUpstash();
    await client.upload(makeState());

    server.kv.clear();
    server.writes.length = 0;

    const stats = await client.upload(makeState());
    expect(stats.uploaded).toBe(6);
  });

  test("download skips sessions that are unchanged", async () => {
    const server = installFakeUpstash();
    const state = makeState();
    await client.upload(state);

    server.gets.length = 0;
    const restored = await client.download(state);

    // 只读了索引；所有会话 / store 都因为哈希一致被跳过
    expect(server.gets).toEqual(["backup-v2-index"]);
    expect(restored[StoreKey.Chat].sessions).toHaveLength(2);
    expect(restored[StoreKey.Chat].sessions[0].messages[0].content).toBe(
      "hello",
    );
  });

  test("download only fetches the sessions that differ", async () => {
    const server = installFakeUpstash();
    await client.upload(makeState());

    const localState = makeState();
    localState[StoreKey.Chat].sessions[0].messages[0].content = "local edit";

    server.gets.length = 0;
    const restored = await client.download(localState);

    expect(server.gets).toContain("backup-v2-s-s1");
    expect(server.gets).not.toContain("backup-v2-s-s2");
    // 差异项以云端为准
    expect(restored[StoreKey.Chat].sessions[0].messages[0].content).toBe(
      "hello",
    );
  });

  test("download rebuilds the app state", async () => {
    installFakeUpstash();
    await client.upload(makeState("hello", "world"));

    const restored = await client.download();
    expect(restored[StoreKey.Chat].sessions).toHaveLength(2);
    expect(restored[StoreKey.Chat].sessions[0].messages[0].content).toBe(
      "hello",
    );
    expect(restored[StoreKey.Access]).toEqual({ openaiApiKey: "key" });
    expect(restored[StoreKey.Config]).toEqual({ theme: "auto" });
  });

  test("large sessions are chunked and restored byte-exact", async () => {
    // 关掉压缩，专门验证分片逻辑
    const savedCompression = (globalThis as any).CompressionStream;
    const savedDecompression = (globalThis as any).DecompressionStream;
    delete (globalThis as any).CompressionStream;
    delete (globalThis as any).DecompressionStream;

    try {
      const big = "word ".repeat(250_000); // ~1.25MB
      const server = installFakeUpstash();
      await client.upload(makeState(big));

      expect(server.writes).toContain("backup-v2-s-s1-c0");
      expect(server.writes).toContain("backup-v2-s-s1-c1");
      expect(server.writes).toContain("backup-v2-s-s1-n");

      const restored = await client.download();
      expect(restored[StoreKey.Chat].sessions[0].messages[0].content).toBe(big);
    } finally {
      (globalThis as any).CompressionStream = savedCompression;
      (globalThis as any).DecompressionStream = savedDecompression;
    }
  });

  test("stale chunks are deleted when the content shrinks", async () => {
    // 关掉压缩，保证一定按 1MB 切片
    const savedCompression = (globalThis as any).CompressionStream;
    const savedDecompression = (globalThis as any).DecompressionStream;
    delete (globalThis as any).CompressionStream;
    delete (globalThis as any).DecompressionStream;

    try {
      const server = installFakeUpstash();
      // 约 2.5MB → 3 片
      await client.upload(makeState("word ".repeat(500_000)));
      expect(server.kv.has("backup-v2-s-s1-c2")).toBe(true);

      // 缩到约 1.25MB → 2 片，第 3 片应该被清掉
      await client.upload(makeState("word ".repeat(250_000)));
      expect(server.kv.has("backup-v2-s-s1-c1")).toBe(true);
      expect(server.kv.has("backup-v2-s-s1-c2")).toBe(false);

      // 再缩到不需要分片：所有分片和 -n 都应删除
      await client.upload(makeState("tiny"));
      expect(server.kv.has("backup-v2-s-s1-c0")).toBe(false);
      expect(server.kv.has("backup-v2-s-s1-n")).toBe(false);
    } finally {
      (globalThis as any).CompressionStream = savedCompression;
      (globalThis as any).DecompressionStream = savedDecompression;
    }
  });

  test("分片数量超过 64 也能全部清掉（按 -n 精确清）", async () => {
    const server = installFakeUpstash();
    await client.upload(makeState());

    // 手工造一个 100 片的分片会话（旧版本只扫 64 片，会漏掉后 36 片）
    for (let i = 0; i < 100; i++) {
      server.kv.set(`backup-v2-s-s2-c${i}`, `chunk-${i}`);
    }
    server.kv.delete("backup-v2-s-s2");
    server.kv.set("backup-v2-s-s2-n", "100");

    const index = readIndex(server);
    const entry = index.sessions.find((s: any) => s.id === "s2");
    entry.chunked = true;
    server.kv.set("backup-v2-index", JSON.stringify(index));

    await client.clearRemote();

    for (let i = 0; i < 100; i++) {
      expect(server.kv.has(`backup-v2-s-s2-c${i}`)).toBe(false);
    }
    expect(server.kv.has("backup-v2-s-s2-n")).toBe(false);
  });

  test("读不到 -n 时按上限兜底扫描残留分片", async () => {
    const server = installFakeUpstash();
    await client.upload(makeState());

    // 模拟“写了一半”：有分片但没有 -n
    server.kv.set("backup-v2-s-s1-c0", "a");
    server.kv.set("backup-v2-s-s1-c1", "b");
    server.kv.delete("backup-v2-s-s1-n");

    await client.clearRemote();

    expect(server.kv.has("backup-v2-s-s1-c0")).toBe(false);
    expect(server.kv.has("backup-v2-s-s1-c1")).toBe(false);
  });

  test("clearRemote wipes every key under the store prefix", async () => {
    // 关掉压缩，保证会话会被切片
    const savedCompression = (globalThis as any).CompressionStream;
    const savedDecompression = (globalThis as any).DecompressionStream;
    delete (globalThis as any).CompressionStream;
    delete (globalThis as any).DecompressionStream;

    try {
      const server = installFakeUpstash();
      await client.upload(makeState("word ".repeat(500_000)));
      expect(server.kv.has("backup-v2-s-s1-c0")).toBe(true);

      const removed = await client.clearRemote();
      expect(removed).toBeGreaterThan(0);

      // 索引、会话单 key、分片、分片计数都应该被删掉
      expect(server.kv.has("backup-v2-index")).toBe(false);
      expect(server.kv.has("backup-v2-s-s1")).toBe(false);
      expect(server.kv.has("backup-v2-s-s1-c0")).toBe(false);
      expect(server.kv.has("backup-v2-s-s1-n")).toBe(false);

      // 清空后再下载应该读不到任何东西
      const restored = await client.download();
      expect(restored).toBeNull();
    } finally {
      (globalThis as any).CompressionStream = savedCompression;
      (globalThis as any).DecompressionStream = savedDecompression;
    }
  });

  test("chunk size setting controls how many chunks are written", async () => {
    // 关掉压缩，保证体积可预测
    const savedCompression = (globalThis as any).CompressionStream;
    const savedDecompression = (globalThis as any).DecompressionStream;
    delete (globalThis as any).CompressionStream;
    delete (globalThis as any).DecompressionStream;

    try {
      const server = installFakeUpstash();
      const smallChunks = createUpstashClient(
        makeSyncStore({ chunkSizeKB: 16 }),
      );
      // 约 200KB，按 16KB 切片应该远多于 1 片
      const big = "word ".repeat(40_000);
      await smallChunks.upload(makeState(big));

      const chunkKeys = Array.from(server.kv.keys()).filter((k) =>
        k.startsWith("backup-v2-s-s1-c"),
      );
      expect(chunkKeys.length).toBeGreaterThan(2);

      // 下载不依赖分片大小，照样能拼回原样
      const restored = await smallChunks.download();
      expect(restored[StoreKey.Chat].sessions[0].messages[0].content).toBe(big);
    } finally {
      (globalThis as any).CompressionStream = savedCompression;
      (globalThis as any).DecompressionStream = savedDecompression;
    }
  });

  test("a failed chunk write aborts the upload instead of silently writing the index", async () => {
    const savedCompression = (globalThis as any).CompressionStream;
    const savedDecompression = (globalThis as any).DecompressionStream;
    delete (globalThis as any).CompressionStream;
    delete (globalThis as any).DecompressionStream;

    try {
      // 第 3 个分片写入失败（模拟单条超过 1MB 的 413）
      const server = installFakeUpstash({
        failWrite: (key) => key.endsWith("-c2"),
      });

      await expect(
        client.upload(makeState("word ".repeat(500_000))),
      ).rejects.toThrow(/c2/);

      // 索引绝对不能写：否则之后的增量会以为这个会话已经同步过了
      expect(server.kv.has("backup-v2-index")).toBe(false);
    } finally {
      (globalThis as any).CompressionStream = savedCompression;
      (globalThis as any).DecompressionStream = savedDecompression;
    }
  });

  test("chunk size is clamped to the Upstash 10MB request limit", () => {
    // 10240KB = 10MB，正好等于请求上限
    expect(resolveChunkBytes(10240)).toBe(10 * 1000 * 1000);
    // 超过上限一律夹回来
    expect(resolveChunkBytes(20480)).toBe(10 * 1000 * 1000);
    // 太小 / 非法值也要有兜底
    expect(resolveChunkBytes(1)).toBe(16 * 1024);
    expect(resolveChunkBytes(undefined)).toBe(1024 * 1024);
  });

  test("chunked is decided by bytes, not by character count", async () => {
    // 中文 1 字符≈3 字节：40 万字符 ≈ 1.2MB 字节。
    // 用 16KB 的分块大小做客户端，保证这条会话一定会被切片，
    // 然后验证索引里记录的 chunked 和实际存储方式一致。
    const cjk = "中文内容".repeat(100_000);
    const server = installFakeUpstash();
    const smallChunks = createUpstashClient(makeSyncStore({ chunkSizeKB: 16 }));

    await smallChunks.upload(makeState(cjk));

    const index = readIndex(server);
    // 索引必须如实记录“已经切片”，否则读端会去读根本不存在的单 key
    expect(index.sessions.find((s: any) => s.id === "s1").chunked).toBe(true);
    expect(server.writes).toContain("backup-v2-s-s1-n");

    const restored = await smallChunks.download();
    expect(restored[StoreKey.Chat].sessions[0].messages[0].content).toBe(cjk);
  });

  test("deleting messages from a chunked session reaches the cloud", async () => {
    const cjk = "中文内容".repeat(100_000);
    const state = makeState(cjk);
    installFakeUpstash();

    await client.upload(state);

    // 删掉一半内容后再上传
    const shorter = cjk.slice(0, cjk.length / 2);
    state[StoreKey.Chat].sessions[0].messages[0].content = shorter;
    const stats = await client.upload(state);
    expect(stats.uploaded).toBeGreaterThan(0);

    const restored = await client.download();
    expect(restored[StoreKey.Chat].sessions[0].messages[0].content).toBe(
      shorter,
    );
  });

  test("upgrades an old (v2) index by re-uploading everything once", async () => {
    const server = installFakeUpstash();
    await client.upload(makeState());

    // 伪造旧版本写下的索引（v2 的 chunked 不可信）
    const index = readIndex(server);
    index.v = 2;
    server.kv.set("backup-v2-index", JSON.stringify(index));

    server.writes.length = 0;
    const stats = await client.upload(makeState()); // 内容没变

    expect(stats.uploaded).toBe(6);
    expect(readIndex(server).v).toBe(3);
  });

  test("download recovers sessions an old index wrongly marked as not chunked", async () => {
    const cjk = "中文内容".repeat(100_000);
    const server = installFakeUpstash();
    await client.upload(makeState(cjk));

    // 模拟旧索引：实际是分片存的，但标成了 chunked:false
    const index = readIndex(server);
    index.v = 2;
    index.sessions.find((s: any) => s.id === "s1").chunked = false;
    server.kv.set("backup-v2-index", JSON.stringify(index));

    const restored = await client.download();
    expect(restored[StoreKey.Chat].sessions[0].messages[0].content).toBe(cjk);
  });

  test("does not compress unless the setting is on", async () => {
    const repetitive = "这是一段会被 gzip 大幅压缩的重复文本。".repeat(2000);
    const server = installFakeUpstash();

    await client.upload(makeState(repetitive));

    const item = readIndex(server).sessions.find((s: any) => s.id === "s1");
    expect(item.gz).toBe(false);
    expect(server.kv.get("backup-v2-s-s1")!.startsWith("{")).toBe(true);
  });

  test("compresses when enabled and restores it", async () => {
    const repetitive = "这是一段会被 gzip 大幅压缩的重复文本。".repeat(2000);
    const server = installFakeUpstash();
    const compressingClient = createUpstashClient(
      makeSyncStore({ useCompression: true }),
    );

    await compressingClient.upload(makeState(repetitive));

    const index = readIndex(server);
    const item = index.sessions.find((s: any) => s.id === "s1");
    expect(item.gz).toBe(true);
    // 存的是 base64，不是原始 JSON
    expect(server.kv.get("backup-v2-s-s1")!.startsWith("{")).toBe(false);
    expect(item.size).toBeLessThan(JSON.stringify(repetitive).length);

    const restored = await compressingClient.download();
    expect(restored[StoreKey.Chat].sessions[0].messages[0].content).toBe(
      repetitive,
    );
  });

  test("re-uploads everything when the compression setting changes", async () => {
    const server = installFakeUpstash();
    await client.upload(makeState()); // 关闭压缩上传一次

    server.writes.length = 0;
    const compressingClient = createUpstashClient(
      makeSyncStore({ useCompression: true }),
    );
    const stats = await compressingClient.upload(makeState());

    // 存储格式变了，即使内容没变也要全部重传
    expect(stats.uploaded).toBe(6);
  });

  test("compresses and decompresses with fflate when the native API is missing", async () => {
    const repetitive = "这是一段会被 gzip 大幅压缩的重复文本。".repeat(2000);
    const server = installFakeUpstash();
    const compressingClient = createUpstashClient(
      makeSyncStore({ useCompression: true }),
    );

    // 模拟 iOS 15：没有 CompressionStream / DecompressionStream
    const savedCompression = (globalThis as any).CompressionStream;
    const savedDecompression = (globalThis as any).DecompressionStream;
    delete (globalThis as any).CompressionStream;
    delete (globalThis as any).DecompressionStream;

    try {
      await compressingClient.upload(makeState(repetitive));

      const item = readIndex(server).sessions.find((s: any) => s.id === "s1");
      expect(item.gz).toBe(true);

      const restored = await compressingClient.download();
      expect(restored[StoreKey.Chat].sessions[0].messages[0].content).toBe(
        repetitive,
      );
    } finally {
      (globalThis as any).CompressionStream = savedCompression;
      (globalThis as any).DecompressionStream = savedDecompression;
    }
  });

  test("stops when the request is aborted", async () => {
    installFakeUpstash();
    const controller = new AbortController();
    const abortedClient = createUpstashClient(makeSyncStore(), {
      signal: controller.signal,
    });

    controller.abort();

    await expect(abortedClient.upload(makeState())).rejects.toThrow("aborted");
    await expect(abortedClient.download()).rejects.toThrow("aborted");
  });

  test("cancelling mid-upload stops before the index is written", async () => {
    const controller = new AbortController();
    const server = installFakeUpstash({
      // 第一批写入完成后就取消
      onWrite: (key) => {
        if (key.startsWith("backup-v2-s-")) controller.abort();
      },
    });
    const state = makeState();
    state[StoreKey.Chat].sessions = Array.from({ length: 30 }, (_, i) =>
      makeSession(`s${i}`, `content ${i}`),
    );

    const client = createUpstashClient(makeSyncStore(), {
      signal: controller.signal,
    });

    await expect(client.upload(state)).rejects.toThrow("aborted");
    // 索引没写 → 远端保持旧状态，下次上传会自己补上
    expect(server.writes).not.toContain("backup-v2-index");
  });

  test("falls back to single writes when pipeline fails", async () => {
    const server = installFakeUpstash({ failPipeline: true });
    const stats = await client.upload(makeState());

    expect(stats.uploaded).toBe(6);
    expect(server.writes).toContain("backup-v2-s-s1");
    expect(server.writes).toContain("backup-v2-s-s2");
    expect(server.writes).toContain("backup-v2-index");
  });

  test("batches many small sessions into few requests", async () => {
    const server = installFakeUpstash();
    const state = makeState();
    state[StoreKey.Chat].sessions = Array.from({ length: 30 }, (_, i) =>
      makeSession(`s${i}`, `content ${i}`),
    );

    await client.upload(state);

    // 30 个会话 + 4 个 store，每批最多 20 条命令 → 2 次 pipeline
    expect(server.pipelineCalls).toBe(2);
    expect(
      server.writes.filter((k) => k.startsWith("backup-v2-s-")).length,
    ).toBe(30);
  });
});
