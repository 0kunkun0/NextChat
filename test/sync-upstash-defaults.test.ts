/**
 * @jest-environment node
 */
/**
 * /api/sync/upstash 的安全契约：必须带正确的访问密码才返回 Upstash 默认配置。
 */
import { ACCESS_CODE_PREFIX } from "../app/constant";

// 模块在第一次 import 时就会读取 CODE 生成访问密码表，
// 所以环境变量要在 beforeAll 里的动态 import 之前设置好。
process.env.CODE = "my-code";
process.env.UPSTASH_URL = "https://example.upstash.io/";
process.env.UPSTASH_TOKEN = "token-value";
delete process.env.UPSTASH_USERNAME;

let POST: (req: any) => Promise<Response>;

beforeAll(async () => {
  ({ POST } = await import("../app/api/sync/upstash/route"));
});

function makeRequest(authorization?: string) {
  return {
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "authorization" ? authorization ?? null : null,
    },
    nextUrl: { pathname: "/api/sync/upstash" },
  } as any;
}

async function call(authorization?: string) {
  const res = await POST(makeRequest(authorization));
  return { status: res.status, body: await res.json() };
}

describe("/api/sync/upstash", () => {
  test("returns the server-side upstash config for a valid access code", async () => {
    const { status, body } = await call(`Bearer ${ACCESS_CODE_PREFIX}my-code`);

    expect(status).toBe(200);
    expect(body).toEqual({
      endpoint: "https://example.upstash.io", // 末尾斜杠应该被去掉
      username: "",
      apiKey: "token-value",
    });
  });

  test("rejects requests without the access code", async () => {
    const { status } = await call();
    expect(status).toBe(401);
  });

  test("rejects a wrong access code", async () => {
    const { status } = await call(`Bearer ${ACCESS_CODE_PREFIX}nope`);
    expect(status).toBe(401);
  });

  test("a random api key cannot bypass the access code", async () => {
    const { status } = await call("Bearer sk-whatever");
    expect(status).toBe(401);
  });

  test("reports a clear error when the server has no upstash config", async () => {
    const savedUrl = process.env.UPSTASH_URL;
    const savedToken = process.env.UPSTASH_TOKEN;
    delete process.env.UPSTASH_URL;
    delete process.env.UPSTASH_TOKEN;

    try {
      const { status, body } = await call(
        `Bearer ${ACCESS_CODE_PREFIX}my-code`,
      );
      expect(status).toBe(404);
      expect(body.error).toBe(true);
    } finally {
      process.env.UPSTASH_URL = savedUrl;
      process.env.UPSTASH_TOKEN = savedToken;
    }
  });

  test("returns the configured backup name", async () => {
    process.env.UPSTASH_USERNAME = "my-backup";
    try {
      const { body } = await call(`Bearer ${ACCESS_CODE_PREFIX}my-code`);
      expect(body.username).toBe("my-backup");
    } finally {
      delete process.env.UPSTASH_USERNAME;
    }
  });
});
