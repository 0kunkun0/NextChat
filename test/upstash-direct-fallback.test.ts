/**
 * 直连被跨域挡住时，必须自动回退到 /api/upstash 代理，而不是直接失败。
 * 单独一个文件：回退标记是模块级的，会污染同文件里其它用例。
 */
import { createUpstashClient } from "../app/utils/cloud/upstash";

function makeStore() {
  return {
    provider: "upstash",
    useProxy: false, // 想直连
    proxyUrl: "",
    useCompression: false,
    upstash: {
      endpoint: "https://example.upstash.io",
      username: "backup",
      apiKey: "token",
    },
  } as any;
}

test("falls back to the proxy when the direct request is blocked", async () => {
  const urls: string[] = [];

  (globalThis as any).fetch = async (url: string) => {
    urls.push(String(url));
    // 模拟浏览器跨域失败：fetch 直接 reject
    if (!String(url).includes("/api/upstash/")) {
      throw new TypeError("Failed to fetch");
    }
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ result: "value-from-proxy" }),
      text: async () => "",
    } as any;
  };

  const client = createUpstashClient(makeStore());
  const value = await client.redisGet("some-key");

  expect(value).toBe("value-from-proxy");
  expect(urls[0]).toBe("https://example.upstash.io/get/some-key");
  expect(urls[1]).toContain("/api/upstash/get/some-key");
});
