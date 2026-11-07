import { TextDecoder, TextEncoder } from "util";
import { CompressionStream, DecompressionStream } from "stream/web";
import { StoreKey } from "../app/constant";
import { createUpstashClient } from "../app/utils/cloud/upstash";
import { hashString } from "../app/utils/format";

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

function makeSyncStore(options: { useCompression?: boolean } = {}) {
  return {
    provider: "upstash",
    useProxy: false,
    proxyUrl: "",
    useCompression: options.useCompression === true,
    upstash: {
      endpoint: "https://example.upstash.io",
      username: "backup",
      apiKey: "token",
    },
  } as any;
}

/** 伪造 Upstash REST 接口（get / set / pipeline），数据存在内存 Map 里 */
function installFakeUpstash(
  options: { failPipeline?: boolean; onWrite?: (key: string) => void } = {},
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
        gets.push(command[1]);
        return { result: kv.has(command[1]) ? kv.get(command[1])! : null };
      });
      return respond(results);
    }

    if (action === "set") {
      kv.set(key, String(init.body ?? ""));
      writes.push(key);
      options.onWrite?.(key);
    } else {
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

  test("second upload only writes the session that changed", async () => {
    const server = installFakeUpstash();
    await client.upload(makeState());

    server.writes.length = 0;
    const stats = await client.upload(makeState("hello, edited"));

    expect(stats.uploaded).toBe(1);
    expect(stats.skipped).toBe(5);
    expect(server.writes).toEqual(["backup-v2-s-s1", "backup-v2-index"]);
  });

  test("uploading unchanged state writes nothing", async () => {
    const server = installFakeUpstash();
    await client.upload(makeState());

    server.writes.length = 0;
    const stats = await client.upload(makeState());

    expect(stats.total).toBe(0);
    expect(server.writes).toEqual([]);
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

describe("multi-device delete propagation", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  test("deleting messages on one device shows up on another", async () => {
    installFakeUpstash();
    const deviceA = createUpstashClient(makeSyncStore());
    const deviceB = createUpstashClient(makeSyncStore());

    // A 上传原版，B 下载得到原版
    await deviceA.upload(makeState("hello", "world"));
    const bState = await deviceB.download(undefined);
    expect(bState[StoreKey.Chat].sessions[0].messages).toHaveLength(1);

    // A 删掉第一条会话里的消息再上传
    const editedState = makeState("hello", "world");
    editedState[StoreKey.Chat].sessions[0].messages = [];
    const stats = await deviceA.upload(editedState);
    expect(stats.uploaded).toBeGreaterThan(0);

    // B 再下载：应该看到删除后的内容
    const bState2 = await deviceB.download(bState);
    expect(bState2[StoreKey.Chat].sessions[0].messages).toHaveLength(0);
  });

  test("truncating a session to fewer messages propagates", async () => {
    installFakeUpstash();
    const deviceA = createUpstashClient(makeSyncStore());
    const deviceB = createUpstashClient(makeSyncStore());

    const original = makeState();
    original[StoreKey.Chat].sessions[0].messages = [
      { id: "m1", role: "user", content: "one", date: "2026/1/1 00:00:00" },
      {
        id: "m2",
        role: "assistant",
        content: "two",
        date: "2026/1/1 00:00:01",
      },
      { id: "m3", role: "user", content: "three", date: "2026/1/1 00:00:02" },
    ];
    await deviceA.upload(original);
    const bState = await deviceB.download(undefined);

    const truncated = makeState();
    truncated[StoreKey.Chat].sessions[0].messages = original[
      StoreKey.Chat
    ].sessions[0].messages.slice(0, 1);
    await deviceA.upload(truncated);

    const bState2 = await deviceB.download(bState);
    expect(bState2[StoreKey.Chat].sessions[0].messages).toHaveLength(1);
    expect(bState2[StoreKey.Chat].sessions[0].messages[0].content).toBe("one");
  });
});

describe("multi-device delete propagation (compressed / chunked)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  function makeCompressedClient() {
    return createUpstashClient({
      provider: "upstash",
      useProxy: false,
      proxyUrl: "",
      useCompression: true,
      upstash: {
        endpoint: "https://example.upstash.io",
        username: "backup",
        apiKey: "token",
      },
    } as any);
  }

  test("compressied sessions also propagate deletions", async () => {
    installFakeUpstash();
    const a = makeCompressedClient();
    const b = makeCompressedClient();

    const big = "重复的中文内容。".repeat(20000); // 压缩率很高
    const original = makeState(big, "world");
    await a.upload(original);
    const bState = await b.download(undefined);
    expect(bState[StoreKey.Chat].sessions[0].messages[0].content).toBe(big);

    const truncated = makeState("只剩下一条", "world");
    await a.upload(truncated);

    const bState2 = await b.download(bState);
    expect(bState2[StoreKey.Chat].sessions[0].messages[0].content).toBe(
      "只剩下一条",
    );
  });

  test("chunked session truncated below the chunk size propagates", async () => {
    installFakeUpstash();
    const a = createUpstashClient(makeSyncStore());
    const b = createUpstashClient(makeSyncStore());

    // 不可压缩、超过 1MB → 走分片
    let seed = 42;
    const randomChar = () => {
      seed = (1103515245 * seed + 12345) % 2147483648;
      return "abcdefghijklmnopqrstuvwxyz"[seed % 26];
    };
    const huge = Array.from({ length: 1_300_000 }, randomChar).join("");

    await a.upload(makeState(huge, "world"));
    const bState = await b.download(undefined);
    expect(bState[StoreKey.Chat].sessions[0].messages[0].content).toBe(huge);

    // 删到只剩一点 → 不再分片
    await a.upload(makeState("short now", "world"));

    const bState2 = await b.download(bState);
    expect(bState2[StoreKey.Chat].sessions[0].messages[0].content).toBe(
      "short now",
    );
  });
});

describe("multi-device delete propagation (chunked -> chunked)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  function randomText(length: number) {
    let seed = 987654321;
    let out = "";
    for (let i = 0; i < length; i++) {
      seed = (1103515245 * seed + 12345) % 2147483648;
      out += "abcdefghijklmnopqrstuvwxyz0123456789"[seed % 36];
    }
    return out;
  }

  test("a 3MB chunked session truncated to 1.5MB is visible on the other device", async () => {
    installFakeUpstash();
    const a = createUpstashClient(makeSyncStore());
    const b = createUpstashClient(makeSyncStore());

    const huge = randomText(3_000_000);
    const smaller = huge.slice(0, 1_500_000);

    await a.upload(makeState(huge, "world"));
    const bState = await b.download(undefined);
    expect(bState[StoreKey.Chat].sessions[0].messages[0].content).toBe(huge);

    await a.upload(makeState(smaller, "world"));

    const bState2 = await b.download(bState);
    expect(bState2[StoreKey.Chat].sessions[0].messages[0].content).toBe(
      smaller,
    );
  });

  test("uploading the same deleted state twice is idempotent", async () => {
    installFakeUpstash();
    const a = createUpstashClient(makeSyncStore());
    const b = createUpstashClient(makeSyncStore());

    await a.upload(makeState("one\ntwo\nthree", "world"));
    const bState = await b.download(undefined);

    const deleted = makeState("one", "world");
    await a.upload(deleted);
    const again = await a.upload(deleted);
    expect(again.total).toBe(0);

    const bState2 = await b.download(bState);
    expect(bState2[StoreKey.Chat].sessions[0].messages[0].content).toBe("one");
  });
});

describe("stale device must not clobber remote edits", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  /** 模拟“这台设备上次上传的是某个版本”（每台设备有自己的本地缓存） */
  function seedLastUpload(s1Hash: string) {
    window.localStorage.setItem(
      "upstash-last-upload-backup",
      JSON.stringify({ hashes: { s1: s1Hash } }),
    );
  }

  test("uploading an old copy does not undo another device's deletion", async () => {
    installFakeUpstash();
    const deviceA = createUpstashClient(makeSyncStore());

    const original = makeState("one\ntwo", "world");
    const originalHash = hashString(
      JSON.stringify(original[StoreKey.Chat].sessions[0]),
    );

    await deviceA.upload(original);

    // 另一台设备删掉一半内容后上传
    await deviceA.upload(makeState("one", "world"));

    // 这台设备（旧副本）上次上传的还是原始版本
    seedLastUpload(originalHash);

    // 旧副本再上传：必须识别为冲突，不能把云端改回旧的
    const deviceB = createUpstashClient(makeSyncStore());
    const bStats = await deviceB.upload(original);
    expect(bStats.conflicts).toBe(1);
    expect(bStats.uploaded).toBe(0);

    // 云端仍然是删除后的版本
    const fromCloud = await deviceB.download(undefined);
    expect(fromCloud[StoreKey.Chat].sessions[0].messages[0].content).toBe(
      "one",
    );
  });

  test("a device that is not behind can still upload its own edit", async () => {
    installFakeUpstash();
    const deviceA = createUpstashClient(makeSyncStore());

    const original = makeState("one\ntwo", "world");
    const originalHash = hashString(
      JSON.stringify(original[StoreKey.Chat].sessions[0]),
    );

    await deviceA.upload(original);
    seedLastUpload(originalHash);

    const stats = await deviceA.upload(makeState("one\ntwo\nthree", "world"));
    expect(stats.conflicts).toBe(0);
    expect(stats.uploaded).toBe(1);
  });
});
describe("download updates the known-remote baseline", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  test("editing after a download is not a false conflict", async () => {
    installFakeUpstash();
    const deviceA = createUpstashClient(makeSyncStore());
    const deviceB = createUpstashClient(makeSyncStore());

    // A 上传原版；B 下载到原版（B 的“已知云端版本”随之更新）
    await deviceA.upload(makeState("one\ntwo", "world"));
    await deviceB.download(undefined);

    // A 又改了一次（云端版本变了）
    await deviceA.upload(makeState("one\ntwo\nthree", "world"));

    // B 先下载到最新，再在本地改动后上传 —— 正常流程，不能报冲突
    await deviceB.download(makeState("one\ntwo", "world"));
    const stats = await deviceB.upload(makeState("edited on B", "world"));

    expect(stats.conflicts).toBe(0);
    expect(stats.uploaded).toBe(1);

    const fromCloud = await deviceA.download(undefined);
    expect(fromCloud[StoreKey.Chat].sessions[0].messages[0].content).toBe(
      "edited on B",
    );
  });
});
