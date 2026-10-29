/**
 * 启动 standalone 构建产物。
 *
 * `.next/standalone/server.js` 是 Next 生成的最小启动器，它只做了
 * `process.chdir(__dirname)`，**不会读取 .env / .env.local**。
 * 直接 `node .next/standalone/server.js` 跑起来时，服务端的
 * DEEPSEEK_API_KEY / OPENAI_API_KEY / CUSTOM_MODELS 等全是空的，
 * 表现就是：模型列表变回默认、聊天报
 * “Authentication Fails (auth header format should be Bearer sk-...)”。
 *
 * 这里先用 @next/env 把项目根的 .env* 读进 process.env，再交给
 * standalone server，行为就和 `next start` 一致了。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import nextEnv from "@next/env";

// @next/env 是 CJS，具名导入在 ESM 里不可靠，这里用默认导出解构
const { loadEnvConfig } = nextEnv;

const root = process.cwd();
const standalone = join(root, ".next", "standalone");

if (!existsSync(join(standalone, "server.js"))) {
  console.error(
    "[start-standalone] 找不到 .next/standalone/server.js，请先运行 yarn build",
  );
  process.exit(1);
}

// 项目和构建产物里的 .env* 都读一遍（后者存在时优先）
loadEnvConfig(root, false);
if (existsSync(standalone)) {
  loadEnvConfig(standalone, false);
}

// server.js 是 CJS，动态 import 时会走它的默认导出
await import("../.next/standalone/server.js");
