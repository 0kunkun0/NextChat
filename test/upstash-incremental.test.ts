import { TextDecoder, TextEncoder } from "util";
import { CompressionStream, DecompressionStream } from "stream/web";
import { StoreKey } from "../app/constant";
import { createUpstashClient } from "../app/utils/cloud/upstash";

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
    const match = u.pathname.match(
      /^\/api\/upstash\/(get|set|pipeline)\/(.+?)\/?$/,
    );
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
