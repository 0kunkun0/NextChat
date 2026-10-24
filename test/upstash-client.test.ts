import { TextDecoder, TextEncoder } from "util";
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
    if (!match) throw new Error("unexpected url: " + url);
    const [, action, key] = match;

    if (action === "set") {
      kv.set(key, String(init.body ?? ""));
      writes.push(key);
    }

    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ result: kv.has(key) ? kv.get(key)! : null }),
      text: async () => "",
    } as any;
  };

  return { kv, writes };
}

describe("upstash legacy blob format", () => {
  test("set() chunks a large payload and get() restores it exactly", async () => {
    const { writes } = installFakeUpstash();
    const client = createUpstashClient(makeSyncStore());
    const payload = "word ".repeat(250_000); // ~1.25MB
    const progress: Array<[number, number]> = [];

    await client.set("", payload, (done, total) =>
      progress.push([done, total]),
    );

    expect(
      writes.filter((key) => /-chunk-\d+$/.test(key)).length,
    ).toBeGreaterThan(1);
    // 分片全部写完才写总数
    expect(writes.at(-1)).toBe("backup-chunk-count");
    // 进度最终收敛
    expect(progress.at(-1)?.[0]).toBe(progress.at(-1)?.[1]);

    await expect(client.get()).resolves.toBe(payload);
  });

  test("set() skips empty payloads", async () => {
    const { writes } = installFakeUpstash();
    const client = createUpstashClient(makeSyncStore());

    await client.set("", "");

    expect(writes).toEqual([]);
  });
});
