/**
 * @jest-environment node
 */
/**
 * 服务端没配访问密码（CODE）时，/api/sync/upstash 必须拒绝返回令牌，
 * 否则这个按钮就成了任何人都能用的“取钥匙”入口。
 *
 * 单独一个文件：access code 表是模块加载时生成的，不能在同一文件里改。
 */
let POST: (req: any) => Promise<Response>;

beforeAll(async () => {
  delete process.env.CODE;
  process.env.UPSTASH_URL = "https://example.upstash.io";
  process.env.UPSTASH_TOKEN = "token-value";
  ({ POST } = await import("../app/api/sync/upstash/route"));
});

test("refuses to expose credentials without an access code on the server", async () => {
  const res = await POST({
    headers: { get: () => null },
    nextUrl: { pathname: "/api/sync/upstash" },
  } as any);

  expect(res.status).toBe(403);
  const body = await res.json();
  expect(body.error).toBe(true);
});
