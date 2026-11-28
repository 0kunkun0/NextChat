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

/**
 * 分片会话的读取成本。
 *
 * 以前：先 GET `-n` 拿到片数，再 N 个并发 GET —— 直连 Upstash、单次往返
 * 一两秒时，一个几十片的会话就要十几二十秒（用户实测 21 秒）。
 * 现在：片数记在索引里，所有分片合并进 pipeline 请求。
 */

function makeSyncStore(chunkSizeKB: number) {
  return {
    provider: "upstash",
    useProxy: false,
    proxyUrl: "",
    useCompression: false,
    upstash: {
      endpoint: "https://example.upstash.io",
      username: "backup",
      apiKey: "token",
      chunkSizeKB,
    },
  } as any;
}

function installFakeUpstash() {
  const kv = new Map<string, string>();
  const individualGets: string[] = [];
  const pipelineGets: string[] = [];
  let pipelineCalls = 0;

  (globalThis as any).fetch = async (url: string, init: any = {}) => {
    const u = new URL(String(url), "http://localhost");
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
      const commands = JSON.parse(String(init.body ?? "[]")) as string[][];
      const results = commands.map((command) => {
        if (command[0] === "SET") {
          kv.set(command[1], command[2]);
          return { result: "OK" };
        }
        if (command[0] === "DEL") {
          let count = 0;
          for (const item of command.slice(1)) {
            if (kv.delete(item)) count += 1;
          }
          return { result: count };
        }
        if (command[0] === "EXISTS") {
          return { result: command.slice(1).filter((k) => kv.has(k)).length };
        }
        pipelineGets.push(command[1]);
        return { result: kv.has(command[1]) ? kv.get(command[1])! : null };
      });
      return respond(results);
    }

    if (action === "set") {
      kv.set(key, String(init.body ?? ""));
      return respond({ result: "OK" });
    }

    individualGets.push(key);
    return respond({ result: kv.has(key) ? kv.get(key)! : null });
  };

  return {
    kv,
    individualGets,
    pipelineGets,
    get pipelineCalls() {
      return pipelineCalls;
    },
  };
}

function makeState(contentSize: number) {
  return {
    [StoreKey.Chat]: {
      sessions: [
        {
          id: "big",
          topic: "big",
          messages: [
            {
              id: "m1",
              role: "user",
              content: "x".repeat(contentSize),
              date: "2026/1/1 00:00:00",
            },
          ],
          mask: {},
          stat: { tokenCount: 0, wordCount: 0, charCount: 0 },
          lastUpdate: 1,
          lastSummarizeIndex: 0,
          memoryPrompt: "",
        },
      ],
      currentSessionIndex: 0,
      lastInput: "",
    },
    [StoreKey.Access]: { openaiApiKey: "key" },
    [StoreKey.Config]: { theme: "auto" },
    [StoreKey.Mask]: { masks: {} },
    [StoreKey.Prompt]: { prompts: {} },
  } as any;
}

describe("upstash chunked session read", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  test("索引里记下分片数，下载时用 pipeline 读分片", async () => {
    const server = installFakeUpstash();
    // 16KB 分片（下限）→ 60KB 的会话会被切成 4 片
    const client = createUpstashClient(makeSyncStore(1));

    await client.upload(makeState(60000));

    const index = JSON.parse(server.kv.get("backup-v2-index")!);
    const entry = index.sessions.find((item: any) => item.id === "big");
    expect(entry.chunked).toBe(true);
    expect(entry.chunks).toBeGreaterThan(1);

    // 清掉记录，模拟一次全新的下载
    server.individualGets.length = 0;
    server.pipelineGets.length = 0;
    const readsBefore = server.pipelineCalls;

    const remote = await client.download({}, undefined, { forceFull: true });

    const session = remote?.[StoreKey.Chat]?.sessions?.[0];
    expect(session?.messages?.[0]?.content).toBe("x".repeat(60000));

    // 分片全部走 pipeline，一次请求搞定
    const chunkGets = server.pipelineGets.filter((key) => /-c\d+$/.test(key));
    expect(chunkGets.length).toBe(entry.chunks);
    // 分片不再逐个 GET（也不去读 -n）
    expect(
      server.individualGets.filter((key) => /-c\d+$|-n$/.test(key)),
    ).toEqual([]);
    // 整个下载的分片读取只多了一次 pipeline 请求
    expect(server.pipelineCalls - readsBefore).toBeLessThanOrEqual(2);
  });

  test("老索引（没有 chunks 字段）仍能读：退回读 -n", async () => {
    const server = installFakeUpstash();
    const client = createUpstashClient(makeSyncStore(1));
    await client.upload(makeState(60000));

    // 模拟旧版本写下的索引：删掉 chunks 字段
    const index = JSON.parse(server.kv.get("backup-v2-index")!);
    index.sessions.forEach((item: any) => delete item.chunks);
    server.kv.set("backup-v2-index", JSON.stringify(index));

    server.individualGets.length = 0;
    const remote = await client.download({}, undefined, { forceFull: true });

    expect(remote?.[StoreKey.Chat]?.sessions?.[0]?.messages?.[0]?.content).toBe(
      "x".repeat(60000),
    );
    // 老索引只能先问 -n（一次单独 GET），但分片本身仍然走 pipeline
    expect(server.individualGets.filter((key) => /-n$/.test(key)).length).toBe(
      1,
    );
  });
});
