import { NextRequest, NextResponse } from "next/server";

async function handle(
  req: NextRequest,
  { params }: { params: { action: string; key: string[] } },
) {
  const requestUrl = new URL(req.url);
  const endpoint = requestUrl.searchParams.get("endpoint");

  if (req.method === "OPTIONS") {
    return NextResponse.json({ body: "OK" }, { status: 200 });
  }
  const [...key] = params.key;
  // only allow to request to *.upstash.io
  if (!endpoint || !new URL(endpoint).hostname.endsWith(".upstash.io")) {
    return NextResponse.json(
      {
        error: true,
        msg: "you are not allowed to request " + params.key.join("/"),
      },
      {
        status: 403,
      },
    );
  }

  // 只放开 upstash 的 get / set / pipeline（pipeline 用于批量读写）
  const allowedActions = ["get", "set", "pipeline"];
  if (!allowedActions.includes(params.action)) {
    console.log("[Upstash Route] forbidden action ", params.action);
    return NextResponse.json(
      {
        error: true,
        msg: "you are not allowed to request " + params.action,
      },
      {
        status: 403,
      },
    );
  }

  // pipeline 没有 key：POST <endpoint>/pipeline，body 是命令数组
  const targetUrl =
    params.action === "pipeline"
      ? `${endpoint}/pipeline`
      : `${endpoint}/${params.action}/${params.key.join("/")}`;

  const method = req.method;
  const shouldNotHaveBody = ["get", "head"].includes(
    method?.toLowerCase() ?? "",
  );

  const headers: Record<string, string> = {
    authorization: req.headers.get("authorization") ?? "",
  };
  const contentType = req.headers.get("content-type");
  if (contentType) {
    headers["content-type"] = contentType;
  }

  const fetchOptions: RequestInit = {
    headers,
    body: shouldNotHaveBody ? null : req.body,
    method,
    // @ts-ignore
    duplex: "half",
  };

  console.log("[Upstash Proxy]", targetUrl, fetchOptions);
  const fetchResult = await fetch(targetUrl, fetchOptions);

  console.log("[Any Proxy]", targetUrl, {
    status: fetchResult.status,
    statusText: fetchResult.statusText,
  });

  return fetchResult;
}

export const POST = handle;
export const GET = handle;
export const OPTIONS = handle;

export const runtime = "edge";
