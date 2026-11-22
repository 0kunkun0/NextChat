import { TextDecoder, TextEncoder } from "node:util";

import { StoreKey } from "../app/constant";
import { createUpstashClient } from "../app/utils/cloud/upstash";

// jsdom 里没有这两个全局对象，分片写入要算字节数
(globalThis as any).TextEncoder ||= TextEncoder;
(globalThis as any).TextDecoder ||= TextDecoder;

/**
 * 知识库（extraStores）能否随上传/下载往返。
 *
 * 用一个内存版 Upstash 伪造 fetch：只实现客户端真正用到的
 * get / set / pipeline / keys，足够覆盖「写索引 + 写数据 + 读回来」这条链路。
 */
function createFakeRedis() {
  const data = new Map<string, string>();
  const calls: string[] = [];

  // jsdom 里没有全局 Response，这里返回客户端真正用到的字段
  const json = (body: any, status = 200) =>
    ({
      ok: status < 400,
      status,
      statusText: String(status),
      json: async () => body,
      text: async () => JSON.stringify(body),
    }) as any;

  const fakeFetch = async (input: any, init?: any): Promise<Response> => {
    const url = String(typeof input === "string" ? input : input.url);
    // 形如 https://fake.upstash.io/get/xxx 或 /set/xxx
    const path = url.replace(/^https?:\/\/[^/]+\//, "");
    const [action, ...rest] = path.split("/");
    const key = decodeURIComponent(rest.join("/"));
    calls.push(`${action} ${key}`);

    if (action === "get") {
      return json({ result: data.get(key) ?? null });
    }
    if (action === "set") {
      data.set(key, typeof init?.body === "string" ? init.body : "");
      return json({ result: "OK" });
    }
    if (action === "pipeline") {
      const commands = JSON.parse(init?.body ?? "[]") as string[][];
      return json(
        commands.map((command) => {
          const [name, ...args] = command;
          if (name === "EXISTS") {
            return { result: data.has(args[0]) ? 1 : 0 };
          }
          if (name === "GET") {
            return { result: data.get(args[0]) ?? null };
          }
          if (name === "SET") {
            data.set(args[0], args[1] ?? "");
            return { result: "OK" };
          }
          return { result: null };
        }),
      );
    }
    if (action === "keys") {
      const pattern = key.replace(/\*$/, "");
      return json([...data.keys()].filter((name) => name.startsWith(pattern)));
    }
    return json({ result: null });
  };

  return { data, calls, fakeFetch };
}

function makeStore() {
  return {
    provider: "upstash",
    useProxy: false,
    proxyUrl: "",
    useCompression: false,
    upstash: {
      endpoint: "https://fake.upstash.io",
      username: "chatgpt-next-web",
      apiKey: "fake-key",
      chunkSizeKB: 1024,
    },
  } as any;
}

function appState() {
  return {
    [StoreKey.Chat]: {
      sessions: [
        {
          id: "s1",
          topic: "会话一",
          messages: [{ id: "m1", role: "user", content: "hi", date: "" }],
          lastUpdate: 1,
        },
      ],
      lastUpdate: 1,
    },
    [StoreKey.Access]: {},
    [StoreKey.Config]: { lastUpdateTime: 1 },
    [StoreKey.Mask]: { masks: {} },
    [StoreKey.Prompt]: { prompts: [] },
  } as any;
}

const KNOWLEDGE_KEY = "__knowledge__";

describe("知识库随上传/下载往返", () => {
  let fake: ReturnType<typeof createFakeRedis>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    fake = createFakeRedis();
    originalFetch = globalThis.fetch;
    globalThis.fetch = fake.fakeFetch as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("上传时把知识库写进索引和数据 key", async () => {
    const client = createUpstashClient(makeStore());
    const knowledge = JSON.stringify({
      version: 1,
      docs: [{ id: "doc-1", name: "ikun.md", chunks: 2 }],
      chunks: [{ id: "doc-1-0", text: "超时设置" }],
    });

    await client.upload(appState(), undefined, {
      extraStores: { [KNOWLEDGE_KEY]: knowledge },
    });

    const index = JSON.parse(
      fake.data.get("chatgpt-next-web-v2-index") ?? "{}",
    );
    const storeIds = (index.stores ?? []).map((item: any) => item.id);
    expect(storeIds).toContain(KNOWLEDGE_KEY);

    // 数据本身也写进去了（未分片时是单 key）
    expect(fake.data.get(`chatgpt-next-web-v2-t-${KNOWLEDGE_KEY}`)).toBe(
      knowledge,
    );
  });

  test("下载时能把知识库取回来", async () => {
    const client = createUpstashClient(makeStore());
    const knowledge = JSON.stringify({ version: 1, docs: [], chunks: [] });
    await client.upload(appState(), undefined, {
      extraStores: { [KNOWLEDGE_KEY]: knowledge },
    });

    const remote = await client.download({} as any);
    // 下载回来的是已解析的对象（upstash.download 里会 JSON.parse 过）
    expect(remote?.[KNOWLEDGE_KEY as any]).toEqual(JSON.parse(knowledge));
  });

  test("内容没变时不重传（增量）", async () => {
    const client = createUpstashClient(makeStore());
    const knowledge = JSON.stringify({ version: 1, docs: [], chunks: [] });
    await client.upload(appState(), undefined, {
      extraStores: { [KNOWLEDGE_KEY]: knowledge },
    });

    const before = fake.calls.filter((call) =>
      call.includes(`-t-${KNOWLEDGE_KEY}`),
    ).length;
    await client.upload(appState(), undefined, {
      extraStores: { [KNOWLEDGE_KEY]: knowledge },
    });
    const after = fake.calls.filter((call) =>
      call.includes(`-t-${KNOWLEDGE_KEY}`),
    ).length;

    // 第二次只做 EXISTS 核对，不再 SET
    expect(after - before).toBeLessThanOrEqual(1);
  });

  test("清空知识库（空 payload）也会同步", async () => {
    const client = createUpstashClient(makeStore());
    await client.upload(appState(), undefined, {
      extraStores: { [KNOWLEDGE_KEY]: '{"version":1,"docs":[],"chunks":[]}' },
    });

    const remote = await client.download({} as any);
    expect((remote?.[KNOWLEDGE_KEY as any] as any).docs).toEqual([]);
  });

  test("超过单 key 上限的知识库会分片写入并能读回", async () => {
    // 4MB 左右：强制走 writeValue 的切片路径
    const big = "x".repeat(4 * 1024 * 1024);
    const knowledge = JSON.stringify({ version: 1, docs: [], chunks: [big] });

    const client = createUpstashClient(makeStore());
    await client.upload(appState(), undefined, {
      extraStores: { [KNOWLEDGE_KEY]: knowledge },
    });

    const index = JSON.parse(
      fake.data.get("chatgpt-next-web-v2-index") ?? "{}",
    );
    const item = (index.stores ?? []).find(
      (entry: any) => entry.id === KNOWLEDGE_KEY,
    );
    expect(item?.chunked).toBe(true);

    const remote = await client.download({} as any);
    expect((remote?.[KNOWLEDGE_KEY as any] as any).chunks[0].length).toBe(
      big.length,
    );
  }, 30000);
});
