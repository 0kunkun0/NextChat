import type { CryptoBundle, KdfParams } from "./crypto";

/**
 * 内存中的「当前解锁状态」。
 *
 * 密钥只以不可导出的 CryptoKey 形式存在这里，从不写进 zustand / IndexedDB /
 * localStorage（除非用户主动勾选「记住密码」）。
 * 锁定时把引用置空，原始字节在 crypto.ts 里早已 fill(0)。
 */

let active: CryptoBundle | null = null;

export function getActiveBundle(): CryptoBundle | null {
  return active;
}

export function hasActiveKey(): boolean {
  return active !== null;
}

export function setActiveBundle(bundle: CryptoBundle | null) {
  active = bundle;
}

export function lockKey() {
  active = null;
}

/* --------------------------- 记住密码（本机保存材料） --------------------------- */

const REMEMBER_KEY = "nextchat-enc-key";

export interface RememberedKey {
  /** base64(32 字节 AES + 32 字节 HMAC) */
  material: string;
  params: KdfParams;
}

export function saveRememberedKey(value: RememberedKey | null) {
  try {
    if (!value) {
      window.localStorage.removeItem(REMEMBER_KEY);
      return;
    }
    window.localStorage.setItem(REMEMBER_KEY, JSON.stringify(value));
  } catch {
    // 隐私模式写不进去：仅本次会话有效
  }
}

export function readRememberedKey(): RememberedKey | null {
  try {
    const raw = window.localStorage.getItem(REMEMBER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RememberedKey;
    if (!parsed?.material || !parsed?.params?.salt) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearRememberedKey() {
  saveRememberedKey(null);
}
