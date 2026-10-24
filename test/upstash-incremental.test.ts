import { TextDecoder, TextEncoder } from "util";
import { StoreKey } from "../app/constant";
import { createUpstashClient } from "../app/utils/cloud/upstash";

// jsdom 没有 TextEncoder/TextDecoder，分片逻辑依赖它们
if (typeof globalThis.TextEncoder === "undefined") {
  (globalThis as any).TextEncoder = TextEncoder;
}
if (typeof globalThis.TextDecoder === "undefined") {
  (globalThis as any).TextDecoder = TextDecoder;
}

function makeSyncStore() {
  return {
    provider: "upstash",
    useProxy: false,
    proxyUrl: "",
    upstash: {
      endpoint: "https://example.upstash.io",
      username: "backup",
      apiKey: "token",
    },
  } as any;
}

/** 伪造 Upstash REST 接口，把 key/value 存在内存 Map 里 */
function installFakeUpstash() {
  const kv = new Map<string, string>();
  const writes: string[] = [];

  (globalThis as any).fetch = async (url: string, init: any = {}) => {
    const u = new URL(String(url), "http://localhost");
    const match = u.pathname.match(/^\/api\/upstash\/(get|set)\/(.+?)\/?$/);
    if (!match) {
      throw new Error("unexpected url: " + url);
    }
    const [, action, key] = match;

    if (action === "set") {
      kv.set(key, String(init.body ?? ""));
      writes.push(key);
    }

    const value = kv.has(key) ? kv.get(key)! : null;
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ result: value }),
      text: async () => "",
    } as any;
  };

  return { kv, writes };
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

const client = createUpstashClient(makeSyncStore());

describe("upstash incremental upload", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  test("first upload writes every session, store and the index", async () => {
    const { writes } = installFakeUpstash();
    const stats = await client.upload(makeState());

    expect(stats.uploaded).toBe(6); // 2 个会话 + 4 个 store
    expect(stats.skipped).toBe(0);
    expect(writes).toContain("backup-v2-s-s1");
    expect(writes).toContain("backup-v2-s-s2");
    expect(writes).toContain("backup-v2-t-access-control");
    expect(writes).toContain("backup-v2-index");
  });

  test("second upload only writes the session that changed", async () => {
    const server = installFakeUpstash();
    await client.upload(makeState());

    server.writes.length = 0; // 保留已上传的数据，只清写入记录
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

    // 云端被清空（或换了库）：本地缓存不能再信
    server.kv.clear();
    server.writes.length = 0;

    const stats = await client.upload(makeState());
    expect(stats.uploaded).toBe(6);
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
    const big = "word ".repeat(250_000); // ~1.25MB
    const { writes } = installFakeUpstash();
    await client.upload(makeState(big));

    expect(writes).toContain("backup-v2-s-s1-c0");
    expect(writes).toContain("backup-v2-s-s1-c1");
    expect(writes).toContain("backup-v2-s-s1-n");

    const restored = await client.download();
    expect(restored[StoreKey.Chat].sessions[0].messages[0].content).toBe(big);
  });
});
