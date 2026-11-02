import md5 from "spark-md5";
import { NextRequest, NextResponse } from "next/server";

import { getServerSideConfig } from "@/app/config/server";
import { ACCESS_CODE_PREFIX } from "@/app/constant";

/**
 * 把服务端 .env 里配的 Upstash 备份地址 / 令牌按需发给前端。
 *
 * 为什么不用 NEXT_PUBLIC_*：
 * 那些值会被打进前端 bundle，任何人打开 F12 就能拿到 Upstash 令牌
 * （等于拿到全部备份），连访问密码都挡不住。改成点按钮才请求：
 * - 只认访问密码（CODE），不能用一个随便的 API Key 绕过；
 * - 服务端没配访问密码时直接拒绝，否则这个按钮就成了公开的“取钥匙”入口。
 *
 * 用 Node runtime（不导出 runtime），process.env 是运行时读取的，
 * 改完 .env 重启即可生效，不需要重新 build。
 */

/** 从 Authorization 里取出访问密码（`Bearer nk-xxx`） */
function parseAccessCode(authorization: string) {
  const token = authorization
    .trim()
    .replace(/^Bearer\s+/i, "")
    .trim();
  return token.startsWith(ACCESS_CODE_PREFIX)
    ? token.slice(ACCESS_CODE_PREFIX.length).trim()
    : "";
}

async function handle(req: NextRequest) {
  const serverConfig = getServerSideConfig();

  if (!serverConfig.needCode) {
    return NextResponse.json(
      {
        error: true,
        msg: "server has no access code (CODE); refusing to expose sync credentials",
      },
      { status: 403 },
    );
  }

  // 注意：不要直接用 auth()，它允许“用户自带的 API Key”通过校验，
  // 而这里返回的是备份的钥匙，必须只对知道访问密码的人开放。
  const accessCode = parseAccessCode(req.headers.get("Authorization") ?? "");
  const hashedCode = md5.hash(accessCode).trim();

  if (!accessCode || !serverConfig.codes.has(hashedCode)) {
    return NextResponse.json(
      {
        error: true,
        msg: accessCode ? "wrong access code" : "empty access code",
      },
      { status: 401 },
    );
  }

  const endpoint = serverConfig.upstashUrl?.trim();
  const token = serverConfig.upstashToken?.trim();

  if (!endpoint || !token) {
    return NextResponse.json(
      {
        error: true,
        msg: "server did not configure UPSTASH_URL / UPSTASH_TOKEN",
      },
      { status: 404 },
    );
  }

  return NextResponse.json({
    // 去掉末尾斜杠，避免拼出 //set/ 这种路径
    endpoint: endpoint.replace(/\/+$/, ""),
    username: serverConfig.upstashUsername?.trim() ?? "",
    apiKey: token,
  });
}

export const POST = handle;
export const GET = handle;
