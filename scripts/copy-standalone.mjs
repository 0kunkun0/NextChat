/**
 * standalone 构建产物补全。
 *
 * `next build` 的 output: "standalone" 只会把 server 和依赖的 node_modules
 * 放进 .next/standalone，**不会**带上 .next/static 和 public。
 * 直接 `node .next/standalone/server.js` 启动时，页面能出来，但所有
 * /_next/static/*.js、*.css 以及 public 里的资源（site.webmanifest、
 * serviceWorkerRegister.js 等）都会 404，表现就是一直卡在加载动画。
 *
 * 这里按照 Next 官方部署文档把这两个目录拷进去。
 */
import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const standalone = join(root, ".next", "standalone");

if (!existsSync(standalone)) {
  // 不是 standalone 构建（比如 BUILD_MODE=export），什么都不用做
  process.exit(0);
}

const copies = [
  [join(root, ".next", "static"), join(standalone, ".next", "static")],
  [join(root, "public"), join(standalone, "public")],
];

for (const [from, to] of copies) {
  if (!existsSync(from)) {
    console.warn(`[copy-standalone] skip missing ${from}`);
    continue;
  }
  cpSync(from, to, { recursive: true, force: true });
  console.log(`[copy-standalone] ${from} -> ${to}`);
}

// standalone/server.js 不会自己读 .env*，提醒用带环境变量加载的启动脚本
console.log(
  "[copy-standalone] 启动请用 `yarn start:standalone`（会加载 .env*）",
);
