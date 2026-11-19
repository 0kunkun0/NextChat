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
  clearRememberedKey,
  getActiveBundle,
  readRememberedKey,
  saveRememberedKey,
  setActiveBundle,
} from "./crypto-session";
import { resolveKeySource, sameKdfParams } from "./crypto-params";

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
    try {
      const session = await decryptSession(bundle, JSON.parse(json));
      return JSON.stringify(session);
    } catch (e) {
      // 密钥不对：丢掉本机记住的密钥，下次会重新要密码，
      // 而不是一直用一把永远解不开的钥匙重试
      if (String((e as any)?.message ?? "").includes("DECRYPT_FAILED")) {
        clearRememberedKey();
        setActiveBundle(null);
      }
      throw e;
    }
  };
}

/** 两组 KDF 参数是否指向同一把钥匙（salt + 迭代次数都要一致） */
export { resolveKeySource, sameKdfParams } from "./crypto-params";

/**
 * 拿到可用的密钥。
 *
 * 关键点：**以云端索引里的加密参数为准**。
 * 每台设备各自「启用加密」会生成各自的 salt，同一个密码派生出的钥匙不同；
 * 以前这里只看内存里有没有钥匙就直接用，于是另一台设备下载时必然解密失败
 * （提示密码不正确），只能先关掉本地加密再重新输密码——典型的 bug 现象。
 *
 * 现在的顺序：
 * 1. 云端没有加密参数 → 返回本机钥匙（上传时用于首次启用），否则 null；
 * 2. 内存 / 记住的钥匙与云端参数一致 → 直接用；
 * 3. 参数不一致或没有钥匙 → 弹窗要密码，用**云端的参数**派生。
 */
export async function ensureBundle(client: {
  readIndexMeta: () => Promise<{ enc?: KdfParams } | null>;
}): Promise<CryptoBundle | null> {
  const active = getActiveBundle();
  const remembered = readRememberedKey();

  // 云端参数决定“这份数据到底是哪把钥匙加密的”
  const meta = await client.readIndexMeta().catch(() => null);
  const cloudParams = meta?.enc ?? null;

  // 云端有加密参数，但本机这把钥匙不一定是同一把：交给纯函数判断
  const source = resolveKeySource({
    cloudParams,
    activeParams: active?.params,
    rememberedParams: remembered?.params,
  });

  // 云端这份备份没加密；本机有钥匙的话上传时继续用它（首次启用）
  if (source === "none") return active;
  if (source === "active") return active;

  if (source === "remembered" && remembered) {
    try {
      const bundle = await importKeyMaterial(
        remembered.material,
        remembered.params,
      );
      setActiveBundle(bundle);
      return bundle;
    } catch (e) {
      console.warn("[Encryption] failed to restore remembered key", e);
      clearRememberedKey();
    }
  }

  // 走到这里说明：云端有加密参数，但本机没有能用的钥匙（或参数不一致）
  const mismatched = !!(active || remembered);
  const input = await askEncryptPassword({
    title: Locale.Settings.Sync.Encryption.UnlockTitle,
    tip: mismatched
      ? Locale.Settings.Sync.Encryption.UnlockTipMismatch
      : Locale.Settings.Sync.Encryption.UnlockTip,
    showRemember: true,
  });
  if (!input) throw new EncryptionLockedError("canceled");

  if (!cloudParams) throw new EncryptionLockedError("no-params");
  const result = await unlockAndExport(input.password, cloudParams);
  if (!result) throw new EncryptionLockedError("wrong-password");

  setActiveBundle(result.bundle);
  if (input.remember) {
    saveRememberedKey({ material: result.material, params: cloudParams });
  }
  return result.bundle;
}
