import { askEncryptPassword } from "../components/password-modal";
import Locale from "../locales";
import {
  decryptSession,
  encryptSession,
  importKeyMaterial,
  isCryptoAvailable,
  keyedHash,
  unlockAndExport,
  type CryptoBundle,
  type KdfParams,
} from "./crypto";
import {
  getActiveBundle,
  readRememberedKey,
  saveRememberedKey,
  setActiveBundle,
} from "./crypto-session";

/** 云端有加密数据，但用户取消 / 密码错误：调用方必须中止本次操作 */
export class EncryptionLockedError extends Error {
  constructor(message = "encryption-locked") {
    super(message);
    this.name = "EncryptionLockedError";
  }
}

export function ensureCryptoSupported() {
  if (!isCryptoAvailable()) throw new EncryptionLockedError("unsupported");
}

/** 上传时的会话变换：加密内容 + 用明文算增量哈希 */
export function makePrepareHook(bundle: CryptoBundle) {
  return async (session: any) => {
    const plaintextJson = JSON.stringify(session);
    const encrypted = await encryptSession(bundle, session);
    return {
      json: JSON.stringify(encrypted),
      // 加密后的 JSON 每次都不一样（随机 IV），所以哈希必须来自明文
      hash: await keyedHash(bundle.macKey, plaintextJson),
    };
  };
}

/** 下载时的解密：密文 JSON → 明文 JSON */
export function makeDecodeHook(bundle: CryptoBundle) {
  return async (json: string) => {
    const session = await decryptSession(bundle, JSON.parse(json));
    return JSON.stringify(session);
  };
}

/**
 * 拿到可用的密钥：
 * 1. 内存里已解锁 → 直接用；
 * 2. 本机记住过材料 → 直接重建（不需要密码）；
 * 3. 云端索引里有加密参数 → 弹窗要密码 → 校验 → 解锁；
 * 4. 云端没有加密参数 → 返回 null（说明这份备份没加密）。
 */
export async function ensureBundle(client: {
  readIndexMeta: () => Promise<{ enc?: KdfParams } | null>;
}): Promise<CryptoBundle | null> {
  const active = getActiveBundle();
  if (active) return active;

  const remembered = readRememberedKey();
  if (remembered) {
    try {
      const bundle = await importKeyMaterial(
        remembered.material,
        remembered.params,
      );
      setActiveBundle(bundle);
      return bundle;
    } catch (e) {
      console.warn("[Encryption] failed to restore remembered key", e);
    }
  }

  const meta = await client.readIndexMeta();
  const params = meta?.enc;
  if (!params) return null;

  const input = await askEncryptPassword({
    title: Locale.Settings.Sync.Encryption.UnlockTitle,
    tip: Locale.Settings.Sync.Encryption.UnlockTip,
    showRemember: true,
  });
  if (!input) throw new EncryptionLockedError("canceled");

  const result = await unlockAndExport(input.password, params);
  if (!result) throw new EncryptionLockedError("wrong-password");

  setActiveBundle(result.bundle);
  if (input.remember) {
    saveRememberedKey({ material: result.material, params });
  }
  return result.bundle;
}
