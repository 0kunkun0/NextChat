import { TextDecoder, TextEncoder } from "util";
import { createUpstashClient } from "../app/utils/cloud/upstash";

// jsdom 没有 TextEncoder/TextDecoder，而分片逻辑（utils/format.ts）依赖它们
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

describe("upstash client upload", () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    calls.length = 0;
    (globalThis as any).fetch = async (url: string) => {
      calls.push(String(url));
      // 让每个请求有一点延迟，模拟真实往返
      await new Promise((resolve) => setTimeout(resolve, 1));
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ result: "1" }),
        text: async () => "",
      } as any;
    };
  });

  afterEach(() => {
    (globalThis as any).fetch = originalFetch;
  });

  test("writes every chunk and stores the chunk count last", async () => {
    // ~1.8MB，会被切成多片
    const state = { text: "x ".repeat(600_000) };
    const client = createUpstashClient(makeSyncStore());
    const progress: Array<[number, number]> = [];

    await client.upload(state, (done, total) => progress.push([done, total]));

    const chunkWrites = calls.filter((url) => /-chunk-\d+/.test(url));
    expect(chunkWrites.length).toBeGreaterThan(1);

    // 所有分片都写完之后，才写 chunk-count
    expect(calls.at(-1)).toContain("-chunk-count");

    // 进度最终收敛到 done === total
    expect(progress.at(-1)).toEqual([chunkWrites.length, chunkWrites.length]);
  });

  test("works without a progress callback", async () => {
    const client = createUpstashClient(makeSyncStore());
    await expect(client.upload({ text: "small" })).resolves.toBeUndefined();
    expect(calls.at(-1)).toContain("-chunk-count");
  });
});
