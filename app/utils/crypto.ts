import type { ChatSession } from "../store/chat";

/**
 * 云端内容加密：AES-256-GCM + PBKDF2-SHA256，全部走浏览器原生 WebCrypto。
 *
 * 设计要点：
 * - 每个字段单独加密，随机 12 字节 IV，密文格式 `enc1:<base64(iv|ct)>`；
 * - 云端索引里只存 salt / 迭代次数 / 校验值，**永远不存密码**；
 * - 派生出的原始字节用完立刻 `fill(0)`，密钥以不可导出（extractable: false）
 *   的 CryptoKey 形式存在内存里；
 * - 用 HMAC 对**明文**算增量哈希：内容没变 → MAC 不变 → 增量同步照常工作，
 *   而云端拿到的只是一个无法反推的 MAC。
 */

/** 密文前缀：以后换算法可以改成 enc2: 平滑迁移 */
export const ENC_PREFIX = "enc1:";
/** 默认迭代次数（OWASP 对 PBKDF2-SHA256 的推荐量级） */
export const DEFAULT_ITERATIONS = 600_000;
/** 迭代次数下限：太低就等于没加密 */
const MIN_ITERATIONS = 100_000;

export interface KdfParams {
  v: 1;
  kdf: "PBKDF2-SHA256";
  iter: number;
  /** 随机 salt（base64） */
  salt: string;
  /** 用一个固定串加密出来的校验值，密码错时 GCM 校验会失败 */
  check: string;
}

export interface CryptoBundle {
  /** 加密内容用的 AES-GCM 密钥 */
  encKey: CryptoKey;
  /** 算增量哈希用的 HMAC 密钥 */
  macKey: CryptoKey;
  params: KdfParams;
}

/** 当前环境下能不能用 WebCrypto（必须安全上下文：HTTPS / localhost） */
export function isCryptoAvailable(): boolean {
  try {
    return (
      typeof crypto !== "undefined" &&
      typeof crypto.subtle !== "undefined" &&
      typeof crypto.getRandomValues === "function"
    );
  } catch {
    return false;
  }
}

/* ------------------------------ 编解码工具 ------------------------------ */

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/* ------------------------------ 密钥派生 ------------------------------ */

/** 由密码派生 64 字节密钥材料（32 字节 AES + 32 字节 HMAC） */
async function deriveRawMaterial(
  password: string,
  params: Pick<KdfParams, "salt" | "iter">,
): Promise<Uint8Array> {
  const passBytes = new TextEncoder().encode(password);
  const salt = fromBase64(params.salt);
  const iterations = Math.max(
    MIN_ITERATIONS,
    Number(params.iter) || DEFAULT_ITERATIONS,
  );

  let bits: ArrayBuffer | null = null;
  try {
    const baseKey = await crypto.subtle.importKey(
      "raw",
      passBytes as any,
      "PBKDF2",
      false,
      ["deriveBits"],
    );

    bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: salt as any, iterations, hash: "SHA-256" },
      baseKey,
      512,
    );

    return new Uint8Array(bits).slice();
  } finally {
    passBytes.fill(0);
    salt.fill(0);
    if (bits) new Uint8Array(bits).fill(0);
  }
}

/** 把 64 字节材料导入成两把不可导出的 CryptoKey（导入后立刻清零原始字节） */
async function importRawMaterial(
  material: Uint8Array,
): Promise<{ encKey: CryptoKey; macKey: CryptoKey }> {
  const encRaw = material.slice(0, 32);
  const macRaw = material.slice(32, 64);
  try {
    const encKey = await crypto.subtle.importKey(
      "raw",
      encRaw as any,
      "AES-GCM",
      false,
      ["encrypt", "decrypt"],
    );
    const macKey = await crypto.subtle.importKey(
      "raw",
      macRaw as any,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return { encKey, macKey };
  } finally {
    encRaw.fill(0);
    macRaw.fill(0);
    material.fill(0);
  }
}

/**
 * 由密码派生加密 / 哈希两把密钥。
 *
 * 注意：`password` 是字符串，JS 里无法原地清零（不可变），
 * 我们只能保证编码出来的 Uint8Array 和派生结果都立刻被清零。
 */
export async function deriveKeys(
  password: string,
  params: Pick<KdfParams, "salt" | "iter">,
): Promise<{ encKey: CryptoKey; macKey: CryptoKey }> {
  const material = await deriveRawMaterial(password, params);
  return importRawMaterial(material);
}

/**
 * 「记住密码在此设备」：把派生出的 64 字节材料编码保存。
 * 注意这只是把「需要密码」变成「需要拿到这台设备」，
 * 本机被攻破时等同于明文，界面上必须写清楚。
 */
export async function exportKeyMaterial(
  password: string,
  params: Pick<KdfParams, "salt" | "iter">,
): Promise<string> {
  const material = await deriveRawMaterial(password, params);
  try {
    return toBase64(material);
  } finally {
    material.fill(0);
  }
}

/** 用保存下来的材料重建两把密钥（不需要密码） */
export async function importKeyMaterial(
  encoded: string,
  params: KdfParams,
): Promise<CryptoBundle> {
  const material = fromBase64(encoded);
  const { encKey, macKey } = await importRawMaterial(material);
  return { encKey, macKey, params };
}

/** 生成新的 KDF 参数（开启加密时用一次） */
export async function createKdfParams(
  password: string,
  iterations: number = DEFAULT_ITERATIONS,
): Promise<{ params: KdfParams; bundle: CryptoBundle; material: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const params: Partial<KdfParams> = {
    v: 1,
    kdf: "PBKDF2-SHA256",
    iter: iterations,
    salt: toBase64(salt),
  };
  salt.fill(0);

  const materialBytes = await deriveRawMaterial(password, params as any);
  let material = "";
  try {
    material = toBase64(materialBytes);
    const { encKey, macKey } = await importRawMaterial(materialBytes.slice());
    const check = await encryptText(encKey, "nextchat-enc-check");
    const fullParams = { ...(params as KdfParams), check };

    return {
      params: fullParams,
      bundle: { encKey, macKey, params: fullParams },
      // 一次派生就把可保存的材料一起给出来，避免「记住密码」时再跑一遍 PBKDF2
      material,
    };
  } finally {
    materialBytes.fill(0);
  }
}

/** 用密码 + 已有参数解锁；密码错误返回 null（GCM 校验失败） */
export async function unlockWithPassword(
  password: string,
  params: KdfParams,
): Promise<CryptoBundle | null> {
  const result = await unlockAndExport(password, params);
  return result ? result.bundle : null;
}

/**
 * 解锁并顺便导出可保存的密钥材料（只跑一次 PBKDF2）。
 * 「记住密码在本设备」时用这个，避免派生两遍。
 */
export async function unlockAndExport(
  password: string,
  params: KdfParams,
): Promise<{ bundle: CryptoBundle; material: string } | null> {
  const materialBytes = await deriveRawMaterial(password, params);
  try {
    const material = toBase64(materialBytes);
    const { encKey, macKey } = await importRawMaterial(materialBytes.slice());

    try {
      const text = await decryptText(encKey, params.check);
      if (text !== "nextchat-enc-check") return null;
    } catch {
      return null;
    }

    return { bundle: { encKey, macKey, params }, material };
  } finally {
    materialBytes.fill(0);
  }
}

/* ------------------------------ 加解密 ------------------------------ */

export async function encryptText(
  key: CryptoKey,
  text: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(text);
  try {
    const cipher = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as any },
      key,
      data as any,
    );
    const merged = new Uint8Array(iv.length + cipher.byteLength);
    merged.set(iv, 0);
    merged.set(new Uint8Array(cipher), iv.length);
    return ENC_PREFIX + toBase64(merged);
  } finally {
    data.fill(0);
  }
}

export async function decryptText(
  key: CryptoKey,
  payload: string,
): Promise<string> {
  if (!payload.startsWith(ENC_PREFIX)) {
    // 兼容未加密的历史数据
    return payload;
  }
  const merged = fromBase64(payload.slice(ENC_PREFIX.length));
  const iv = merged.slice(0, 12);
  const body = merged.slice(12);

  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as any },
    key,
    body as any,
  );
  iv.fill(0);
  merged.fill(0);
  return new TextDecoder().decode(plain);
}

/** 增量哈希：HMAC-SHA256(明文)，输出 32 位十六进制 */
export async function keyedHash(key: CryptoKey, text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  try {
    const sig = await crypto.subtle.sign("HMAC", key, data as any);
    return Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } finally {
    data.fill(0);
  }
}

export function isEncrypted(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(ENC_PREFIX);
}

/* ------------------------------ 会话级变换 ------------------------------ */

/** 需要加密的文本字段（消息正文、候选回复、标题、记忆摘要） */
async function mapContent(
  bundle: CryptoBundle,
  session: any,
  transform: (text: string) => Promise<string>,
): Promise<any> {
  const clone = { ...session };

  if (typeof clone.topic === "string" && clone.topic) {
    clone.topic = await transform(clone.topic);
  }
  if (typeof clone.memoryPrompt === "string" && clone.memoryPrompt) {
    clone.memoryPrompt = await transform(clone.memoryPrompt);
  }

  clone.messages = Array.isArray(session.messages)
    ? await Promise.all(
        session.messages.map(async (message: any) => {
          const next = { ...message };

          if (typeof message.content === "string") {
            next.content = await transform(message.content);
          } else if (
            message.content !== undefined &&
            message.content !== null
          ) {
            // 多模态：整体 JSON 化后加密，解密时再还原。
            // 加一个标记，避免把「内容本身就是 JSON 数组文本」的普通消息解成数组
            next.content = await transform(
              JSON.stringify({ __ncArr: message.content }),
            );
          }

          if (Array.isArray(message.variants)) {
            next.variants = await Promise.all(
              message.variants.map(async (variant: any) => {
                if (typeof variant?.content !== "string") return variant;
                return {
                  ...variant,
                  content: await transform(variant.content),
                };
              }),
            );
          }

          return next;
        }),
      )
    : session.messages;

  return clone;
}

/** 会话 → 云端形态（内容加密） */
export async function encryptSession(
  bundle: CryptoBundle,
  session: ChatSession,
): Promise<ChatSession> {
  return mapContent(bundle, session, (text) =>
    encryptText(bundle.encKey, text),
  );
}

/** 云端形态 → 会话（内容解密）；遇到未加密的旧数据原样返回 */
export async function decryptSession(
  bundle: CryptoBundle,
  session: any,
): Promise<any> {
  return mapContent(bundle, session, async (text) => {
    if (!isEncrypted(text)) return text;
    const plain = await decryptText(bundle.encKey, text);
    // 多模态：带标记的才当数组还原，避免误伤「内容本身是 JSON」的普通消息
    if (plain.startsWith("{")) {
      try {
        const parsed = JSON.parse(plain);
        if (parsed && typeof parsed === "object" && "__ncArr" in parsed) {
          return (parsed as any).__ncArr;
        }
      } catch {
        // 就是普通文本，忽略
      }
    }
    return plain;
  });
}
