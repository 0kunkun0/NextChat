import hljs from "highlight.js/lib/core";

/**
 * 代码高亮的按需加载。
 *
 * rehype-highlight（lowlight）会把 highlight.js 的**全部语言**打进包，
 * 首屏白拿几百 KB，而实际用到的不过十几种。这里改成：
 * 只用 `highlight.js/lib/core`，每种语言一个动态 import，
 * 用到才下载（和 DeepSeek demo 里按需加载 Prism 语言包同一个思路，
 * 但不用引入新依赖——highlight.js 本来就在）。
 *
 * 未加载 / 不支持的语言先按纯文本显示，加载完触发一次重渲染。
 */

/** 不支持高亮的“语言”（按纯文本处理） */
const PLAIN = new Set([
  "",
  "text",
  "txt",
  "plaintext",
  "plain",
  "markdown",
  "md",
  "tex",
  "latex",
]);

/** 别名 → highlight.js 语言名 */
const ALIASES: Record<string, string> = {
  "c++": "cpp",
  cxx: "cpp",
  cc: "cpp",
  hpp: "cpp",
  h: "cpp",
  cs: "csharp",
  "c#": "csharp",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  ps: "powershell",
  ps1: "powershell",
  yml: "yaml",
  html: "xml",
  htm: "xml",
  svg: "xml",
  xhtml: "xml",
  objc: "objectivec",
  "objective-c": "objectivec",
  js: "javascript",
  ts: "typescript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  kt: "kotlin",
  asm: "x86asm",
  cmake: "cmake",
  make: "makefile",
  makefile: "makefile",
  dockerfile: "dockerfile",
  "": "plaintext",
};

type LanguageModule = { default: unknown };

/**
 * 语言 → 动态加载器。
 * 只列常用语言；不在表里的按纯文本显示（不报错、不阻塞）。
 */
const LOADERS: Record<string, () => Promise<LanguageModule>> = {
  bash: () => import("highlight.js/lib/languages/bash"),
  c: () => import("highlight.js/lib/languages/c"),
  cpp: () => import("highlight.js/lib/languages/cpp"),
  csharp: () => import("highlight.js/lib/languages/csharp"),
  cmake: () => import("highlight.js/lib/languages/cmake"),
  css: () => import("highlight.js/lib/languages/css"),
  dart: () => import("highlight.js/lib/languages/dart"),
  diff: () => import("highlight.js/lib/languages/diff"),
  dockerfile: () => import("highlight.js/lib/languages/dockerfile"),
  go: () => import("highlight.js/lib/languages/go"),
  graphql: () => import("highlight.js/lib/languages/graphql"),
  haskell: () => import("highlight.js/lib/languages/haskell"),
  ini: () => import("highlight.js/lib/languages/ini"),
  java: () => import("highlight.js/lib/languages/java"),
  javascript: () => import("highlight.js/lib/languages/javascript"),
  json: () => import("highlight.js/lib/languages/json"),
  kotlin: () => import("highlight.js/lib/languages/kotlin"),
  less: () => import("highlight.js/lib/languages/less"),
  lua: () => import("highlight.js/lib/languages/lua"),
  makefile: () => import("highlight.js/lib/languages/makefile"),
  nginx: () => import("highlight.js/lib/languages/nginx"),
  objectivec: () => import("highlight.js/lib/languages/objectivec"),
  perl: () => import("highlight.js/lib/languages/perl"),
  php: () => import("highlight.js/lib/languages/php"),
  powershell: () => import("highlight.js/lib/languages/powershell"),
  protobuf: () => import("highlight.js/lib/languages/protobuf"),
  python: () => import("highlight.js/lib/languages/python"),
  r: () => import("highlight.js/lib/languages/r"),
  ruby: () => import("highlight.js/lib/languages/ruby"),
  rust: () => import("highlight.js/lib/languages/rust"),
  scala: () => import("highlight.js/lib/languages/scala"),
  scss: () => import("highlight.js/lib/languages/scss"),
  sql: () => import("highlight.js/lib/languages/sql"),
  swift: () => import("highlight.js/lib/languages/swift"),
  typescript: () => import("highlight.js/lib/languages/typescript"),
  xml: () => import("highlight.js/lib/languages/xml"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
  x86asm: () => import("highlight.js/lib/languages/x86asm"),
};

/** 已注册到 hljs 的语言 */
const loaded = new Set<string>();
/** 正在加载的语言（避免并发重复加载） */
const loading = new Map<string, Promise<boolean>>();

/** 把代码块的语言标记规范化成 highlight.js 的语言名 */
export function normalizeLanguage(raw?: string | null): string {
  const name = (raw ?? "").trim().toLowerCase();
  if (!name) return "plaintext";
  if (PLAIN.has(name)) return "plaintext";
  const mapped = ALIASES[name] ?? name;
  if (mapped in LOADERS) return mapped;
  // 支持 ```cpp{} 这种带参数的写法
  const head = mapped.split(/[\s{,]/)[0];
  if (head in LOADERS) return head;
  return "plaintext";
}

/** 这个语言是否需要/能够高亮 */
export function canHighlight(lang: string): boolean {
  return lang !== "plaintext" && lang in LOADERS;
}

export function isLanguageLoaded(lang: string): boolean {
  return loaded.has(lang);
}

/**
 * 按需加载一种语言。
 * @returns 是否可用（失败/未知语言返回 false）
 */
export async function loadLanguage(lang: string): Promise<boolean> {
  if (loaded.has(lang)) return true;
  const loader = LOADERS[lang];
  if (!loader) return false;

  const existing = loading.get(lang);
  if (existing) return existing;

  const task = loader()
    .then((module) => {
      hljs.registerLanguage(lang, module.default as any);
      loaded.add(lang);
      return true;
    })
    .catch((error) => {
      console.warn(`[Highlight] failed to load language: ${lang}`, error);
      return false;
    })
    .finally(() => {
      loading.delete(lang);
    });

  loading.set(lang, task);
  return task;
}

/** HTML 转义（未高亮时按纯文本渲染） */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 高亮一段代码。
 * @param code 原始代码
 * @param lang 规范化后的语言
 * @returns 可直接 innerHTML 的字符串（未加载时是转义后的纯文本）
 */
export function highlightCode(code: string, lang: string): string {
  if (!canHighlight(lang) || !isLanguageLoaded(lang)) {
    return escapeHtml(code);
  }
  try {
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  } catch (error) {
    console.warn(`[Highlight] highlight failed: ${lang}`, error);
    return escapeHtml(code);
  }
}
