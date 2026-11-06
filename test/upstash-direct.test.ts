import { createUpstashClient } from "../app/utils/cloud/upstash";

function makeStore(useProxy: boolean) {
  return {
    provider: "upstash",
    useProxy,
    proxyUrl: "",
    useCompression: false,
    upstash: {
      endpoint: "https://example.upstash.io/",
      username: "backup",
      apiKey: "token",
    },
  } as any;
}

function installFake() {
  const urls: string[] = [];
  (globalThis as any).fetch = async (url: string) => {
    urls.push(String(url));
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ result: null }),
      text: async () => "",
    } as any;
  };
  return urls;
}

describe("upstash connection mode", () => {
  test("builds native REST urls for direct mode", () => {
    const client = createUpstashClient(makeStore(false));
    expect(client.directUrl("get", "backup-v2-index")).toBe(
      "https://example.upstash.io/get/backup-v2-index",
    );
    // pipeline 没有 key
    expect(client.directUrl("pipeline")).toBe(
      "https://example.upstash.io/pipeline",
    );
  });

  test("talks to Upstash directly when the proxy is disabled", async () => {
    const urls = installFake();
    const client = createUpstashClient(makeStore(false));

    await client.redisGet("some-key");

    expect(urls).toHaveLength(1);
    expect(urls[0]).toBe("https://example.upstash.io/get/some-key");
  });

  test("goes through /api/upstash when the proxy is enabled", async () => {
    const urls = installFake();
    const client = createUpstashClient(makeStore(true));

    await client.redisGet("some-key");

    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/api/upstash/get/some-key");
    expect(urls[0]).toContain("endpoint=");
  });
});
