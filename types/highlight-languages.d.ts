/**
 * highlight.js 的语言包没有单独的类型声明（`lib/languages/*`），
 * 这里统一声明成 any，避免逐个语言 import 时 TS7016。
 */
declare module "highlight.js/lib/languages/*" {
  const language: any;
  export default language;
}
