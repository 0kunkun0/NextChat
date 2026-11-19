import type { KdfParams } from "./crypto";

/**
 * 加密参数比较 / 选钥匙的纯逻辑。
 *
 * 单独放一个文件：crypto-flow 会 import Locale 和密码弹窗，
 * 依赖链很重；这些判断本身不需要任何依赖，便于单测。
 */

/** 两组 KDF 参数是否指向同一把钥匙（salt + 迭代次数都要一致） */
export function sameKdfParams(
  a?: KdfParams | null,
  b?: KdfParams | null,
): boolean {
  if (!a || !b) return false;
  if (!a.salt || !b.salt) return false;
  return a.salt === b.salt && (a.iter ?? 0) === (b.iter ?? 0);
}

/**
 * 决定这次用哪把钥匙。
 *
 * - `none`：云端没加密（上传时若本机有钥匙则照用）
 * - `active`：内存里的钥匙和云端参数一致
 * - `remembered`：本机记住的钥匙和云端参数一致
 * - `prompt`：参数不一致 / 没有钥匙 → 必须用**云端参数**重新要密码
 */
export function resolveKeySource(input: {
  cloudParams?: KdfParams | null;
  activeParams?: KdfParams | null;
  rememberedParams?: KdfParams | null;
}): "none" | "active" | "remembered" | "prompt" {
  const { cloudParams, activeParams, rememberedParams } = input;
  if (!cloudParams) return "none";
  if (sameKdfParams(activeParams, cloudParams)) return "active";
  if (sameKdfParams(rememberedParams, cloudParams)) return "remembered";
  return "prompt";
}
