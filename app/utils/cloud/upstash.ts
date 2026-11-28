import { gzipSync, gunzipSync, strToU8, strFromU8 } from "fflate";
import { STORAGE_KEY, StoreKey } from "@/app/constant";
import { SyncStore } from "@/app/store/sync";
import { chunks, hashString } from "../format";
import { toBufferSource } from "../bytes";

export type UpstashConfig = SyncStore["upstash"];
export type UpStashClient = ReturnType<typeof createUpstashClient>;

/**
 * 并发写切片的数量。
 * 原来的实现是一片一片串行 await，跨洋链路上 N 片就是 N 个往返；
 * 适度并发（不要太高，否则弱网下反而更慢）能把总耗时压到接近单次往返。
 */
const UPLOAD_CONCURRENCY = 8;
/** 单个 value 超过这个字节数才切片（默认值；实际可在设置里调） */
const CHUNK_BYTES = 1000 * 1000;
/**
 * 单个 value 能被**安全读回来**的上限。
 *
 * 实测（Upstash 免费库，2026-11）：
 *   0.1MB / 0.5MB / 1MB / 2MB → SET 200，GET 返回完整内容；
 *   4MB → SET 返回 200，但 GET 会被服务端中断（连接 terminated）。
 * 也就是说「写得进去」不等于「读得出来」。写 5.9MB 的单个 value 之后，
 * 下载永远读不到它 —— 表现就是「那条对话在云端蒸发了」。
 *
 * 所以单片上限按 1MB 来（也是历史上长期使用的值），
 * 超出一律切片，保证每一片都能读回来。
 */
const SAFE_VALUE_BYTES = 1000 * 1000;
/** 分片上限：不能超过安全读取上限 */
const MAX_CHUNK_BYTES = SAFE_VALUE_BYTES;
/** 分片大小可选范围（KB）：16KB ~ 1024KB（=1MB，保证能读回来） */
const MIN_CHUNK_KB = 16;
const MAX_CHUNK_KB = 1024;
/**
 * 防御性清扫时最多扫这么多个分片。
 *
 * 正常情况下我们用 `-n` 记录的真实数量精确清理，这个上限只在数据被写坏、
 * 读不到 `-n` 时兜底。取 1024（不是 64）：按 16KB 分块、10MB 上限计算
 * 最多需要 ~640 片，1024 留足余量，同时也远没有到“删 6000 个 key”的程度。
 */
const MAX_CHUNK_SWEEP = 1024;
/** 没有设置过（老版本持久化的 store）时用的默认值 */
const DEFAULT_CHUNK_KB = 1024;
/**
 * 单个 pipeline 请求里最多塞多少字符。
 * 请求上限是 10MB，这里保守取 1MB，既明显减少请求数又不至于顶到上限。
 */
const PIPELINE_MAX_CHARS = 1_000_000;
/**
 * 压缩过的内容是 base64（纯 ASCII，1 字符≈1 字节），
 * 同样的上限可以塞更多，请求数能少几倍。
 */
const PIPELINE_MAX_CHARS_COMPRESSED = 1_000_000;
/** 单个 pipeline 请求里最多塞多少条命令 */
const PIPELINE_MAX_COMMANDS = 20;

/** 远程索引里的一项 */
type RemoteItem = {
  id: string;
  chunked: boolean;
  /** 原始 JSON 的哈希，上传/下载时用它跳过没变的项 */
  h?: string;
  /** 是否 gzip + base64 存储 */
  gz?: boolean;
  /** 存储内容的字符数，批量读的预算用 */
  size?: number;
};

/**
 * 远程索引（v2）：
 * - 会话、配置按 key 分开存，上传时可以只传变化的那些；
 * - 索引最后写，保证读端不会读到半截数据；
 * - 每项带 h / gz / size，上传/下载都可以跳过未变项、合并批量请求；
 * - 顶层 compress 记录本次使用的编码方式，切换压缩开关后会整份重写。
 *
 * 判断“哪些变了”直接用远端索引里的哈希，而不是本机缓存：
 * 多设备同步时本机缓存会过期，索引才是权威。
 */
type RemoteIndex = {
  v: number;
  updatedAt: number;
  /** chat store 里除 sessions 之外的字段 */
  chat: Record<string, any>;
  sessions: RemoteItem[];
  stores: RemoteItem[];
  /** 本份数据是否经过 gzip 压缩 */
  compress?: boolean;
};

/* ------------------------------------------------------------------ */
/* 压缩：gzip + base64                                                  */
/* ------------------------------------------------------------------ */

/**
 * 什么时候走浏览器原生的 CompressionStream：
 * 它快得多，但 iOS 15 / Safari < 16.4 没有，此时用 fflate（纯 JS）兜底，
 * 这样任何设备都能压缩 / 解压，格式都是标准 gzip，可以互换。
 */
function hasNativeCompression() {
  return (
    typeof CompressionStream !== "undefined" &&
    typeof DecompressionStream !== "undefined" &&
    typeof btoa !== "undefined" &&
    typeof atob !== "undefined"
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function readAll(readable: ReadableStream<Uint8Array>) {
  const reader = readable.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      parts.push(value);
      total += value.length;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function compressText(text: string): Promise<string> {
  if (!hasNativeCompression()) {
    // iOS 15 等环境：fflate 的纯 JS gzip
    return bytesToBase64(gzipSync(strToU8(text)));
  }

  const stream = new CompressionStream("gzip");
  const writer = stream.writable.getWriter();
  const writing = (async () => {
    await writer.write(toBufferSource(new TextEncoder().encode(text)));
    await writer.close();
  })();
  const bytes = await readAll(stream.readable);
  await writing;
  return bytesToBase64(bytes);
}

async function decompressText(base64: string): Promise<string> {
  if (!hasNativeCompression()) {
    return strFromU8(gunzipSync(base64ToBytes(base64)));
  }

  const stream = new DecompressionStream("gzip");
  const writer = stream.writable.getWriter();
  const writing = (async () => {
    await writer.write(toBufferSource(base64ToBytes(base64)));
    await writer.close();
  })();
  const bytes = await readAll(stream.readable);
  await writing;
  return new TextDecoder().decode(bytes);
}

/** 编码一段 JSON：能压就压（base64 之后确实更小才用），否则原样 */
async function encodePayload(
  json: string,
  compress: boolean,
): Promise<{ payload: string; gz: boolean }> {
  if (compress) {
    try {
      const base64 = await compressText(json);
      // base64 本身会膨胀 33%，只有净收益明显时才用压缩
      if (base64.length < json.length * 0.95) {
        return { payload: base64, gz: true };
      }
    } catch (e) {
      console.warn("[Upstash] compress failed, store raw", e);
    }
  }
  return { payload: json, gz: false };
}

async function decodePayload(raw: string, gz?: boolean): Promise<string> {
  if (!gz) return raw;
  return await decompressText(raw);
}

/** 按命令数 / 字符总量把待处理项分组，避免单次 pipeline 请求过大 */
function groupBatches<T>(
  items: T[],
  sizeOf: (item: T) => number,
  maxChars: number = PIPELINE_MAX_CHARS,
) {
  const batches: T[][] = [];
  let current: T[] = [];
  let chars = 0;

  for (const item of items) {
    const size = sizeOf(item);
    if (
      current.length > 0 &&
      (current.length >= PIPELINE_MAX_COMMANDS || chars + size > maxChars)
    ) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(item);
    chars += size;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

/** 压缩过的项按更大的字符预算分批，未压缩的按保守预算 */
function groupBatchesByEncoding<T extends { gz?: boolean }>(
  items: T[],
  sizeOf: (item: T) => number,
) {
  return [
    ...groupBatches(
      items.filter((item) => item.gz),
      sizeOf,
      PIPELINE_MAX_CHARS_COMPRESSED,
    ),
    ...groupBatches(
      items.filter((item) => !item.gz),
      sizeOf,
      PIPELINE_MAX_CHARS,
    ),
  ];
}

/**
 * 并发跑一批任务。
 *
 * 每个批次都是一次完整的往返（国内到 Upstash 通常 150~300ms），
 * 串行跑 10 个批次就是 2~3 秒；并发 4 个能把总耗时压到 wave 数。
 */
async function runLimited<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
) {
  let cursor = 0;
  const run = async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await worker(item);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

/** 用户点了“取消”导致的错误（AbortController.abort） */
export function isAbortError(error: any) {
  return (
    error?.name === "AbortError" ||
    error?.code === 20 ||
    /aborted/i.test(String(error?.message ?? ""))
  );
}

/**
 * 直连失败后进入冷却（跨 client 实例、跨页面刷新），
 * 冷却结束会重新尝试直连。
 *
 * 以前是「失败一次就永久走代理」——结果一次网络抖动就让这台设备
 * 之后所有同步都绕道代理（Cloudflare → Railway → Upstash），
 * 上传 7MB 要 20 秒。现在冷却 10 分钟后自动重试。
 */
const DIRECT_FLAG_KEY = "upstash-direct-unavailable-until";
/** 直连失败后的冷却时间 */
const DIRECT_COOLDOWN_MS = 10 * 60 * 1000;

function readDirectCooldownUntil(): number {
  try {
    const raw = window.localStorage.getItem(DIRECT_FLAG_KEY);
    // 兼容老版本写的 "1"
    if (!raw || raw === "1") return 0;
    const value = Number(raw);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function saveDirectCooldown(until: number) {
  try {
    window.localStorage.setItem(DIRECT_FLAG_KEY, String(until));
  } catch {
    // 隐私模式写不进去，至少本次会话内有效
  }
}

let directCooldownUntil =
  typeof window === "undefined" ? 0 : readDirectCooldownUntil();

/**
 * 直连超时：**按请求体大小算**。
 *
 * 以前固定 2.5 秒，结果手机上一个 1MB 分片（慢速蜂窝要十几秒）永远超时，
 * 一次超时就把直连永久打成「不可用」，之后所有同步都绕道代理——
 * 这就是「主力机上传 7MB 要 20 秒、直连请求数一直是 0」的原因。
 *
 * 现在：基础 10 秒，再按每 50KB 加 1 秒（相当于最低 50KB/s），上限 60 秒。
 * 只有真正连不上（连接阶段就失败）才会回退代理。
 */
function directTimeoutFor(body?: BodyInit | null): number {
  const bytes = typeof body === "string" ? body.length : 0;
  return Math.min(60_000, 10_000 + Math.ceil(bytes / 50_000) * 1000);
}

/** 分片大小（字节）：夹到 [16KB, 10MB]，并且不超过单次请求上限 */
export function resolveChunkBytes(chunkSizeKB?: number): number {
  const kb = Math.min(
    MAX_CHUNK_KB,
    Math.max(MIN_CHUNK_KB, Number(chunkSizeKB) || DEFAULT_CHUNK_KB),
  );
  return Math.min(kb * 1024, MAX_CHUNK_BYTES);
}

export function createUpstashClient(
  store: SyncStore,
  options?: { signal?: AbortSignal },
) {
  const config = store.upstash;
  const storeKey = config.username.length === 0 ? STORAGE_KEY : config.username;
  /** 取消上传/下载用的信号：读请求立刻中断，写请求做完当前项再停 */
  const signal = options?.signal;

  /** 上传时的分片大小（字节）：设置里可调，范围 16KB ~ 1024KB */
  const chunkBytes = resolveChunkBytes(config.chunkSizeKB);
  const chunkSizeKB = Math.round(chunkBytes / 1024);

  /** 本次同步发出的 HTTP 请求数 / 上行字符数，用于排查“到底慢在哪” */
  let requestCount = 0;
  let bytesOut = 0;
  /** 直连 / 走代理的请求数；排查“是不是每次都在撞直连超时” */
  let directCount = 0;
  let proxyCount = 0;

  /**
   * 索引的短时缓存。
   *
   * 一次同步里索引会被读两次：先由 ensureBundle（判断加密参数）读一次，
   * 上传 / 下载自己再读一次拿哈希。在跨洋链路上这是一整趟往返，
   * 10 秒内复用同一份结果即可，写索引时立即失效。
   */
  const INDEX_CACHE_MS = 10_000;
  let indexRawCache: { at: number; raw: string | null } | null = null;

  /** 实际要上传的原始 JSON 长度 / 压缩后长度，用来算压缩比 */
  let rawCharsToUpload = 0;
  let payloadCharsToUpload = 0;
  /** 这次写了多少个分片 key（-cN + -n），用来解释云端 key 总数 */
  let chunkKeysWritten = 0;

  /** 用户取消后，在下一个项目/批次开始前抛错 */
  const throwIfAborted = () => {
    if (signal?.aborted) {
      const error = new Error("The operation was aborted.");
      error.name = "AbortError";
      throw error;
    }
  };

  // 老格式（整包一条记录 + 分片）——仅用于读取旧备份
  const legacyCountKey = `${storeKey}-chunk-count`;
  const legacyChunkKey = (i: number) => `${storeKey}-chunk-${i}`;

  // 新格式（增量）
  const indexKey = `${storeKey}-v2-index`;
  const sessionKey = (id: string) => `${storeKey}-v2-s-${id}`;
  const storeItemKey = (name: string) => `${storeKey}-v2-t-${name}`;

  const proxyUrl =
    store.useProxy && store.proxyUrl.length > 0 ? store.proxyUrl : undefined;

  /**
   * 直连 Upstash（不走 /api/upstash 代理）。
   *
   * 少一次转发之外，更重要的是连接复用：浏览器到 Upstash 是长连接池，
   * 而经过服务端代理时每条请求都多一段服务端处理/新连接的风险。
   * 关掉「启用代理」即可启用；万一 Upstash 不允许跨域（fetch 直接 reject），
   * 会自动退回代理，只是第一条请求多花一点时间。
   */
  const preferDirect = !store.useProxy;
  let forceProxy = false;

  const isNetworkError = (e: any) =>
    e instanceof TypeError ||
    /Failed to fetch|NetworkError|Load failed|CORS/i.test(
      String(e?.message ?? ""),
    );

  return {
    async check() {
      try {
        const res = await this.request({
          path: `get/${storeKey}`,
          action: "get",
          key: storeKey,
          method: "GET",
          headers: this.headers(),
          signal,
        });
        console.log("[Upstash] check", res.status, res.statusText);
        return [200].includes(res.status);
      } catch (e) {
        console.error("[Upstash] failed to check", e);
      }
      return false;
    },

    async redisGet(key: string) {
      const res = await this.request({
        path: `get/${key}`,
        action: "get",
        key,
        method: "GET",
        headers: this.headers(),
        signal,
      });

      console.log("[Upstash] get key = ", key, res.status, res.statusText);
      const resJson = (await res.json()) as { result: string };

      return resJson.result;
    },

    // 写请求故意不挂 signal：让当前这一项（可能包含多个分片）一次写完，
    // 避免取消时把某个大会话写成“半新半旧”的损坏状态。
    // 取消会在下一个项目/批次开始前生效。
    async redisSet(key: string, value: string) {
      const send = async () => {
        const res = await this.request({
          path: `set/${key}`,
          action: "set",
          key,
          method: "POST",
          headers: this.headers(),
          body: value,
        });

        console.log("[Upstash] set key = ", key, res.status, res.statusText);
        if (res.ok) return;

        const text = await res.text().catch(() => "");
        const error: any = new Error(
          `Upstash set failed (${key}): ${res.status} ${text}`,
        );
        error.status = res.status;
        throw error;
      };

      try {
        await send();
      } catch (e: any) {
        // 用户取消 / 4xx（单条超限 413、鉴权失败等）重试没有意义
        if (
          isAbortError(e) ||
          (typeof e?.status === "number" && e.status < 500)
        ) {
          throw e;
        }
        console.warn("[Upstash] set failed, retry once:", key, e?.message ?? e);
        await send();
      }
    },

    /**
     * 统一出口：能直连就直连，直连失败（典型是跨域被拒）就退回代理。
     */
    async request(options: {
      path: string;
      action: string;
      key?: string;
      method: string;
      headers: Record<string, string>;
      body?: BodyInit | null;
      signal?: AbortSignal;
    }) {
      const { path, action, key, ...init } = options;

      requestCount += 1;
      if (typeof init.body === "string") bytesOut += init.body.length;

      // 调用方已经取消了：直接抛，连请求都不发
      if (init.signal?.aborted) {
        const error = new Error("The operation was aborted.");
        error.name = "AbortError";
        throw error;
      }

      if (!preferDirect || forceProxy || directCooldownUntil > Date.now()) {
        proxyCount += 1;
        return fetch(this.path(path, proxyUrl), init as RequestInit);
      }

      // 直连加超时：卡住的连接不要拖住整个同步
      let timedOut = false;
      const controller = new AbortController();
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, directTimeoutFor(init.body));
      const onAbort = () => controller.abort();
      init.signal?.addEventListener?.("abort", onAbort, { once: true });

      try {
        const response = await fetch(this.directUrl(action, key), {
          ...(init as RequestInit),
          signal: controller.signal,
        });
        directCount += 1;
        return response;
      } catch (e) {
        // 用户主动取消：原样抛出，不要当成“直连不可用”
        if (!timedOut && init.signal?.aborted) throw e;
        if (!timedOut && !isAbortError(e) && !isNetworkError(e)) throw e;

        console.warn(
          timedOut
            ? "[Upstash] direct request timed out, fall back to proxy"
            : "[Upstash] direct request failed, fall back to proxy",
          e,
        );
        forceProxy = true;
        // 记住这次失败（含页面刷新），冷却结束后会重新尝试直连
        directCooldownUntil = Date.now() + DIRECT_COOLDOWN_MS;
        saveDirectCooldown(directCooldownUntil);
        proxyCount += 1;
        return fetch(this.path(path, proxyUrl), init as RequestInit);
      } finally {
        clearTimeout(timer);
        init.signal?.removeEventListener?.("abort", onAbort);
      }
    },

    /** Upstash 原生 REST 路径（直连用） */
    directUrl(action: string, key?: string) {
      const cleanEndpoint = config.endpoint.replace(/\/+$/, "");
      return key
        ? `${cleanEndpoint}/${action}/${key}`
        : `${cleanEndpoint}/${action}`;
    },

    headers() {
      return {
        Authorization: `Bearer ${config.apiKey}`,
      };
    },

    path(path: string, proxyUrl: string = "") {
      const cleanEndpoint = config.endpoint.replace(/\/+$/, "");

      if (proxyUrl.length > 0) {
        proxyUrl = proxyUrl.replace(/\/+$/, "") + "/";
      }

      if (!path.endsWith("/")) {
        path += "/";
      }
      if (path.startsWith("/")) {
        path = path.slice(1);
      }

      let url;
      const pathPrefix = "/api/upstash/";

      try {
        let u = new URL(proxyUrl + pathPrefix + path);
        u.searchParams.append("endpoint", cleanEndpoint);
        url = u.toString();
      } catch (e) {
        url = pathPrefix + path + "?endpoint=" + cleanEndpoint;
      }

      return url;
    },

    /** Upstash REST 的批量接口：一次请求执行多条 GET/SET */
    async pipeline(
      commands: string[][],
      opts?: { signal?: AbortSignal },
    ): Promise<any[]> {
      const res = await this.request({
        path: "pipeline/_",
        action: "pipeline",
        method: "POST",
        headers: {
          ...this.headers(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(commands),
        signal: opts?.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Upstash pipeline failed: ${res.status} ${text}`);
      }

      return (await res.json()) as any[];
    },

    /** 批量写：失败就退回逐条写，保证正确性 */
    async writeBatch(items: Array<{ key: string; payload: string }>) {
      if (items.length === 0) return;
      try {
        const results = await this.pipeline(
          items.map((item) => ["SET", item.key, item.payload]),
        );
        const failed = Array.isArray(results)
          ? results.find((r) => r && r.error)
          : { error: "invalid pipeline response" };
        if (failed) throw new Error(String(failed.error));
      } catch (e) {
        // 用户取消时不要再逐条重试
        if (isAbortError(e)) throw e;
        console.warn("[Upstash] batch write failed, fallback", e);
        await Promise.all(
          items.map((item) => this.redisSet(item.key, item.payload)),
        );
      }
    },

    /** 批量读：失败就退回逐条读 */
    async readBatch(items: Array<{ key: string; size: number }>) {
      const out = new Map<string, string>();
      if (items.length === 0) return out;

      try {
        const results = await this.pipeline(
          items.map((item) => ["GET", item.key]),
          { signal },
        );
        if (!Array.isArray(results))
          throw new Error("invalid pipeline response");
        items.forEach((item, i) => {
          const value = results[i]?.result;
          if (typeof value === "string") out.set(item.key, value);
        });
      } catch (e) {
        if (isAbortError(e)) throw e;
        console.warn("[Upstash] batch read failed, fallback", e);
        await Promise.all(
          items.map(async (item) => {
            const value = await this.redisGet(item.key);
            if (typeof value === "string") out.set(item.key, value);
          }),
        );
      }
      return out;
    },

    /** 老格式读取：整包一条记录，分片拼接 */
    async get() {
      const chunkCount = Number(await this.redisGet(legacyCountKey));
      if (!Number.isInteger(chunkCount)) return;

      const chunks = await Promise.all(
        new Array(chunkCount)
          .fill(0)
          .map((_, i) => this.redisGet(legacyChunkKey(i))),
      );
      console.log("[Upstash] get full chunks", chunks);
      return chunks.join("");
    },

    /** 老格式写入：整包一条记录，切片并发写 */
    async set(
      _: string,
      value: string,
      onProgress?: (done: number, total: number) => void,
    ) {
      if (!value || value.length == 0) {
        console.warn("[Upstash] set called with empty value, skip");
        return;
      }

      const startedAt = Date.now();
      // 先切好分片：并行上传需要知道总片数，进度也需要
      const parts = Array.from(chunks(value));
      const total = parts.length;
      let cursor = 0;
      let done = 0;

      const worker = async () => {
        while (cursor < total) {
          const index = cursor++;
          await this.redisSet(legacyChunkKey(index), parts[index]);
          done += 1;
          onProgress?.(done, total);
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(UPLOAD_CONCURRENCY, total) }, worker),
      );

      // 分片全部写完后再写总数，保证读取端不会读到半截数据
      await this.redisSet(legacyCountKey, total.toString());

      console.log(
        `[Upstash] upload ${total} chunk(s) in ${Date.now() - startedAt}ms`,
      );
    },

    /**
     * 写一个 value：小内容单 key，大内容切片；返回是否切了片。
     *
     * 会顺手清理“上一次遗留的分片”：内容变短以后分片数会减少，
     * 多出来的 `-cN` 如果不删，云端就会一直躺着一堆没人引用的旧分片
     * （缓存里的块数看着就像翻倍）。
     */
    async writeValue(key: string, value: string): Promise<boolean> {
      const parts = Array.from(chunks(value, chunkBytes));

      // 旧的分片数（没有就是 0 / NaN）
      const previousCount = Number(await this.redisGet(`${key}-n`)) || 0;

      if (parts.length <= 1) {
        await this.redisSet(key, value);
        if (previousCount > 0) {
          await this.dropChunks(key, 0, previousCount);
        }
        return false;
      }

      let cursor = 0;
      const worker = async () => {
        while (cursor < parts.length) {
          const index = cursor++;
          await this.redisSet(`${key}-c${index}`, parts[index]);
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.min(UPLOAD_CONCURRENCY, parts.length) },
          worker,
        ),
      );
      await this.redisSet(`${key}-n`, String(parts.length));
      chunkKeysWritten += parts.length + 1;

      // 写完核对分片数：任何一个分片没写成功，这里会立刻报错，
      // 而不是写进索引、让之后的增量误以为「已经同步过了」
      const written = Number(await this.redisGet(`${key}-n`));
      if (written !== parts.length) {
        throw new Error(
          `Upstash chunk write incomplete: ${key} ${written}/${parts.length}`,
        );
      }

      // 新的分片比旧的少：把越界的旧分片删掉
      if (previousCount > parts.length) {
        await this.dropChunks(key, parts.length, previousCount);
      }
      return true;
    },

    /**
     * 删除 [from, to) 区间的旧分片（from 为 0 时连同 -n）。
     * 用 Redis 的多 key DEL：100 个 key 一条命令、5 条命令一个 pipeline，
     * 分片多的时候请求数也不会爆。
     */
    async dropChunks(key: string, from: number, to: number) {
      const keys: string[] = [];
      for (let i = from; i < to; i++) keys.push(`${key}-c${i}`);
      // from === 0 表示这条已经改回“不分片”，连 -n 一起删
      if (from === 0) keys.push(`${key}-n`);
      if (keys.length === 0) return;

      try {
        await this.deleteKeys(keys);
      } catch (e) {
        // 清理失败不影响数据正确性（读端以索引为准），忽略
        console.warn("[Upstash] failed to clean stale chunks", key, e);
      }
    },

    /**
     * 删掉一批 key（多 key DEL + 批量 pipeline）。
     * 之前是一个 key 一条命令、每批 40 条，上千个 key 要跑二十多个请求。
     */
    async deleteKeys(keys: string[]) {
      if (keys.length === 0) return;

      const KEYS_PER_COMMAND = 100;
      const COMMANDS_PER_PIPELINE = 5;

      const commands: string[][] = [];
      for (let i = 0; i < keys.length; i += KEYS_PER_COMMAND) {
        commands.push(["DEL", ...keys.slice(i, i + KEYS_PER_COMMAND)]);
      }

      for (let i = 0; i < commands.length; i += COMMANDS_PER_PIPELINE) {
        throwIfAborted();
        await this.pipeline(commands.slice(i, i + COMMANDS_PER_PIPELINE));
      }
    },

    /**
     * 把一个 key 的所有分片清干净（含 `-n`）。
     *
     * 优先按 `-n` 记录的真实分片数删（精确、请求少）；
     * 读不到 `-n`（数据被写坏 / 只写了一半）时，按 MAX_CHUNK_SWEEP 兜底全扫。
     */
    async sweepChunks(key: string) {
      const recorded = Number(await this.redisGet(`${key}-n`)) || 0;
      const count = recorded > 0 ? recorded : MAX_CHUNK_SWEEP;

      const keys: string[] = [`${key}-n`];
      for (let i = 0; i < count; i++) keys.push(`${key}-c${i}`);
      await this.deleteKeys(keys);
    },

    /** 读一个 value：单 key 或按索引里记录的分片数拼接 */
    async readValue(key: string, chunked: boolean): Promise<string | null> {
      if (!chunked) {
        return (await this.redisGet(key)) ?? null;
      }
      const count = Number(await this.redisGet(`${key}-n`));
      if (!Number.isInteger(count) || count <= 0) {
        // 索引说「已切片」但读不到 -n：有可能实际是单 key 存的
        // （索引和数据的元信息对不上时会出现），回退读一次，别直接把会话丢了
        const single = (await this.redisGet(key)) ?? null;
        if (single !== null) {
          console.warn(
            "[Upstash] index says chunked but -n missing, read as single key:",
            key,
          );
        }
        return single;
      }

      const parts = await Promise.all(
        new Array(count).fill(0).map((_, i) => this.redisGet(`${key}-c${i}`)),
      );
      if (parts.some((p) => p === null || p === undefined)) return null;
      return parts.join("");
    },

    /**
     * 增量上传：
     * 逐会话 / 逐 store 计算内容哈希，只上传和上次成功上传时不一样的部分；
     * 小改动走一次 pipeline 批量写，大会话才单独切片。
     */
    async upload(
      state: any,
      onProgress?: (done: number, total: number) => void,
      options?: {
        forceFull?: boolean;
        /**
         * 会话 → 云端形态的转换（加密时用）。
         * 返回「要上传的 JSON」和「用来做增量比对的哈希」——
         * 加密后 JSON 每次都不一样（随机 IV），所以哈希必须来自明文。
         */
        prepare?: (session: any) => Promise<{ json: string; hash: string }>;
        /** 写进索引的额外元信息（比如加密参数） */
        extraIndex?: Record<string, any>;
        /**
         * 只上传这些会话（其它会话的索引条目原样保留）。
         * 用于「聊天界面右上角直接上传当前会话」：只动一条，
         * 不用把几 MB 的历史全传一遍。
         */
        sessionIds?: string[];
        /**
         * 删除「云端有、本地没有」的会话。
         * 默认 false（上传永不删），只有用户手动勾选时才传 true。
         */
        deleteMissing?: boolean;
        /**
         * 额外的键值对（例如知识库），按 store 的方式一起上传。
         * name 会出现在索引的 stores 里，下载时原样返回。
         */
        extraStores?: Record<string, string>;
      },
    ): Promise<{
      uploaded: number;
      skipped: number;
      total: number;
      /** 本次顺带删掉的「云端有、本地没有」的会话数 */
      deleted: number;
    }> {
      const startedAt = Date.now();
      const chat = state[StoreKey.Chat] ?? {};
      const allSessions: any[] = Array.isArray(chat.sessions)
        ? chat.sessions
        : [];
      const onlyIds = options?.sessionIds?.length
        ? new Set(options.sessionIds)
        : null;
      const sessions = onlyIds
        ? allSessions.filter((session: any) => onlyIds.has(session.id))
        : allSessions;

      /**
       * 会话 id 去重：同一个 id 出现两次会让索引里出现两条同 id 的条目，
       * 下载时按 id 组装会把其中一条顶掉（表现就是“那条对话蒸发了”）。
       * 这里保留第一次出现的，后面的直接跳过并打日志。
       */
      const uniqueSessions: any[] = [];
      const seenSessionIds = new Set<string>();
      for (const session of sessions) {
        const id = session?.id;
        if (typeof id === "string" && id) {
          if (seenSessionIds.has(id)) {
            console.warn(
              "[Upstash] duplicate session id in local state, keeping the first one:",
              id,
              session?.topic,
            );
            continue;
          }
          seenSessionIds.add(id);
        }
        uniqueSessions.push(session);
      }
      const { sessions: _sessions, ...chatMeta } = chat;
      /**
       * lastInput 是输入框里的草稿，属于对话内容。
       * 索引 index 是**明文存储**的（加密也不覆盖它），
       * 所以这里直接把它剔掉，绝不写进云端索引。
       */
      delete (chatMeta as any).lastInput;
      const storeNames = [
        StoreKey.Access,
        StoreKey.Config,
        StoreKey.Mask,
        StoreKey.Prompt,
      ];

      // 压缩是设置项，默认开启；没有原生 CompressionStream 时 fflate 兜底
      const compress = store.useCompression === true;

      // 先把索引请求发出去，等它回来的这段时间顺手把本地序列化 + 哈希算完：
      // 两件事本来都得做，串行做等于白等一个完整往返。
      // 注意：取消时不能让这个 promise 变成“未处理的 rejection”——
      // 下面序列化阶段有 await，期间没人接住就会被判成 unhandled。
      let indexAbortError: unknown = null;
      const indexPromise = this.readIndexRaw().catch((e) => {
        if (isAbortError(e)) {
          indexAbortError = e;
          return null;
        }
        console.warn("[Upstash] failed to read index, upload everything", e);
        return null;
      });

      const considered = uniqueSessions.length + storeNames.length;
      /**
       * 进度只统计「真正要传的条数」。
       *
       * 以前把准备阶段也算进总数：14 条里 11 条没变、3 条要传，
       * 点一下按钮进度就直接是 14/17（82%），然后卡十几秒，看着像卡死。
       * 现在准备阶段不报数，写入阶段从 0/N 开始数。
       */
      onProgress?.(0, 0);

      const hashStartedAt = Date.now();
      let prepared = 0;
      let lastYieldAt = Date.now();
      /** 每 8ms 让出一次主线程，避免序列化大历史时整页卡死 */
      const yieldIfNeeded = async () => {
        if (Date.now() - lastYieldAt < 8) return;
        lastYieldAt = Date.now();
        await new Promise((resolve) => setTimeout(resolve, 0));
      };

      const localSessions: Array<{
        session: any;
        json: string;
        hash: string;
      }> = [];
      for (const session of uniqueSessions) {
        throwIfAborted();
        let json: string;
        let hash: string;
        if (options?.prepare) {
          const encoded = await options.prepare(session);
          json = encoded.json;
          hash = encoded.hash;
        } else {
          json = JSON.stringify(session);
          hash = hashString(json);
        }
        localSessions.push({ session, json, hash });
        prepared += 1;
        await yieldIfNeeded();
      }

      const localStores = storeNames.map((name) => {
        const json = JSON.stringify(state[name] ?? {});
        return { name, json, hash: hashString(json) };
      });

      // 知识库之类的附加 store：和普通 store 一样参与哈希比对 / 增量上传
      for (const [name, json] of Object.entries(options?.extraStores ?? {})) {
        if (typeof json !== "string") continue;
        localStores.push({
          name: name as StoreKey,
          json,
          hash: hashString(json),
        });
      }
      prepared += localStores.length;
      const hashMs = Date.now() - hashStartedAt;

      // - 云端没有索引（换了库 / 被清空）→ 全部重传；
      // - 有的话用它里面的哈希判断哪些项没变（比本机缓存可靠，多设备也不会错）。
      const rawIndex = await indexPromise;
      // 取消的话在这里补上抛出，语义和原来一致
      if (indexAbortError) throw indexAbortError;
      const indexMs = Date.now() - hashStartedAt - hashMs;

      let remoteIndex: RemoteIndex | null = null;
      if (rawIndex) {
        try {
          remoteIndex = JSON.parse(rawIndex) as RemoteIndex;
        } catch (e) {
          console.warn("[Upstash] failed to parse index, upload everything", e);
        }
      }

      const remoteItems = new Map<string, RemoteItem>();
      for (const item of [
        ...(remoteIndex?.sessions ?? []),
        ...(remoteIndex?.stores ?? []),
      ]) {
        remoteItems.set(item.id, item);
      }

      // 压缩开关变了、或者索引是旧版本（chunked 用字符数判断的老 bug）：
      // 之前存的格式不再可靠，所有项都要重写一遍
      const reencodeAll =
        remoteIndex?.compress !== undefined &&
        remoteIndex.compress !== compress;
      const needsRepair = remoteIndex != null && (remoteIndex.v ?? 0) < 3;
      /** 允许“内容没变就跳过”的前提：远端格式是可信的，且没有强制全量 */
      const canSkipUnchanged =
        !options?.forceFull && !reencodeAll && !needsRepair;

      /**
       * 自愈：索引说「这条已经同步过了」，但对应的数据 key 其实不存在。
       *
       * 这种情况真实发生过：索引被写成 chunked、数据却在某次清理里被删掉，
       * 之后每次上传都会因为「哈希一样」跳过它 —— 云端永远缺这一条，
       * 下载时就是用户看到的「那条对话变成虚无」。
       *
       * 这里用一次 pipeline（每项一条 EXISTS）把“该跳过”的项核对一遍，
       * 数据不在的强制重传。chunked 项检查 `-n`，普通项检查 key 本身。
       */
      const brokenIds = new Set<string>();
      /** 单项太大、必须重切成片的 key（值存在但读不回来） */
      const oversizedIds = new Set<string>();
      if (canSkipUnchanged) {
        const candidates: Array<{ id: string; key: string }> = [];
        for (const item of localSessions) {
          const remote = remoteItems.get(item.session.id);
          if (remote?.h !== item.hash) continue;
          const key = sessionKey(item.session.id);

          // 之前用过大分片（比如 1MB 以上）存成单 key 的，改回 1MB 后必须重切：
          // 值虽然存在，但超过安全读取上限，下载时会读不回来。
          if (
            !remote.chunked &&
            typeof remote.size === "number" &&
            remote.size > SAFE_VALUE_BYTES
          ) {
            oversizedIds.add(item.session.id);
            brokenIds.add(item.session.id);
            console.warn(
              "[Upstash] single value too large to read back, re-chunking:",
              item.session.id,
              remote.size,
            );
            continue;
          }

          candidates.push({
            id: item.session.id,
            key: remote.chunked ? `${key}-n` : key,
          });
        }
        for (const item of localStores) {
          const remote = remoteItems.get(item.name);
          if (remote?.h !== item.hash) continue;
          candidates.push({
            id: item.name,
            key: storeItemKey(item.name),
          });
        }

        if (candidates.length > 0) {
          try {
            const results = await this.pipeline(
              candidates.map((item) => ["EXISTS", item.key]),
            );
            results.forEach((result: any, index: number) => {
              const exists = Number(result?.result ?? 0) > 0;
              if (!exists) brokenIds.add(candidates[index].id);
            });
            if (brokenIds.size > 0) {
              console.warn(
                "[Upstash] index says synced but data is missing, re-uploading:",
                Array.from(brokenIds),
              );
            }
          } catch (e) {
            // 校验失败不影响正常上传，只是少了自愈能力
            console.warn("[Upstash] failed to verify remote data", e);
          }
        }
      }
      const repairedIds = new Set<string>();

      const sessionItems: RemoteItem[] = [];
      const storeItems: RemoteItem[] = [];
      const small: Array<{ key: string; payload: string; gz: boolean }> = [];
      // 大项会走 writeValue，是否真的切片要以它实际写的结果为准
      // （中文 1 字符≈3 字节，按字符数判断会得出错误的 chunked）
      const big: Array<{ key: string; payload: string; item: RemoteItem }> = [];
      /** 需要清理旧分片的 key（原来切片、现在不分片了） */
      const staleChunkKeys: string[] = [];
      /** 需要清理旧单 key 的 key（原来不分片、现在切片了） */
      const stalePlainKeys: string[] = [];

      const plan = async (
        kind: "sessions" | "stores",
        id: string,
        json: string,
        hash: string,
      ) => {
        const remote = remoteItems.get(id);

        // 远端已经有完全一样的内容：不重传，索引里沿用远端记录的存储方式
        // （但数据 key 已经丢失的项不算“已有”，走下面的重传逻辑）
        if (canSkipUnchanged && remote?.h === hash && !brokenIds.has(id)) {
          return {
            id,
            chunked: remote.chunked,
            gz: remote.gz,
            h: hash,
            size: remote.size ?? json.length,
          } as RemoteItem;
        }
        if (brokenIds.has(id)) {
          repairedIds.add(id);
          console.warn(
            "[Upstash] repairing missing cloud data:",
            id,
            (json.match(/"topic":"([^"]*)"/) ?? [])[1] ?? "",
          );
        }

        const { payload, gz } = await encodePayload(json, compress);
        // 统计“真正要上传的字节”，用来看压缩比和上行速度
        rawCharsToUpload += json.length;
        payloadCharsToUpload += payload.length;

        const item: RemoteItem = {
          id,
          // 先假设不切片；走 big 的项在写完后会用 writeValue 的返回值覆盖
          chunked: false,
          gz,
          h: hash,
          size: payload.length,
        };

        const key = kind === "sessions" ? sessionKey(id) : storeItemKey(id);
        // 超过这个长度就单独处理（切片写）；分块大小调小时，阈值跟着变小，
        // 这样用户设的“分块大小”才真的是单个请求的粒度
        if (payload.length > Math.min(PIPELINE_MAX_CHARS, chunkBytes)) {
          big.push({ key, payload, item });
          // 原来是不分片的单 key，现在切成片了：旧的单 key 要清掉
          if (remote && !remote.chunked) stalePlainKeys.push(key);
        } else {
          small.push({ key, payload, gz });
          // 原来切片、现在放得下了：旧分片要清掉（否则云端会一直留着）
          if (remote?.chunked) staleChunkKeys.push(key);
        }
        return item;
      };

      for (const item of localSessions) {
        throwIfAborted();
        // 防御：id 不合法 / 不是对象时跳过，避免写出 `-undefined` 这种 key，
        // 也避免把整条会话静默丢掉却看不出来
        if (!item.session || typeof item.session !== "object") {
          console.warn("[Upstash] skip invalid session payload");
          continue;
        }
        if (typeof item.session.id !== "string" || !item.session.id) {
          console.warn("[Upstash] skip session without id", item.session);
          continue;
        }
        sessionItems.push(
          await plan("sessions", item.session.id, item.json, item.hash),
        );
      }
      for (const item of localStores) {
        throwIfAborted();
        storeItems.push(await plan("stores", item.name, item.json, item.hash));
      }

      /**
       * 索引合并：本地有的会话用新条目，**云端已有但本地没有的条目保留**。
       *
       * 以前这里直接用本地的 sessionItems 覆盖整个索引：一旦本地少了一条
       * （拖动 / 删除 / 状态异常），云端索引里的对应条目就被抹掉，
       * 那条对话在云端等于"消失"了 —— 也就是用户看到的"上传吞内容"。
       * 上传永远不删，宁可多留也不要丢。
       */
      const localSessionIds = new Set(sessionItems.map((item) => item.id));
      const remoteSessionsList = remoteIndex?.sessions ?? [];
      const remoteOnlySessions = remoteSessionsList.filter(
        (item) => item && item.id && !localSessionIds.has(item.id),
      );

      /**
       * 默认保留云端独有的会话（上传不删，避免误删）。
       * 用户显式勾选「删除云端已不存在的会话」时，才把这些条目连同数据一起删掉。
       */
      const purgeSessions = options?.deleteMissing ? remoteOnlySessions : [];
      const keptRemoteSessions = options?.deleteMissing
        ? []
        : remoteOnlySessions;

      if (keptRemoteSessions.length > 0) {
        console.warn(
          "[Upstash] keeping remote-only sessions in the index:",
          keptRemoteSessions.map((item) => item.id),
        );
      }
      if (purgeSessions.length > 0) {
        console.log(
          "[Upstash] purging sessions removed locally:",
          purgeSessions.map((item) => item.id),
        );
      }

      /**
       * 索引里的会话列表：
       * - 全量 / 增量：本地顺序 + 云端独有的条目（兜底保留）；
       * - 单条上传（sessionIds）：保持云端原有顺序，只替换被上传那一条，
       *   避免点一次单条上传就把整个侧边栏顺序改了。
       */
      const localItemById = new Map(
        sessionItems.map((item) => [item.id, item]),
      );
      const mergedSessions = onlyIds
        ? [
            ...remoteSessionsList.map(
              (item) => localItemById.get(item.id) ?? item,
            ),
            ...sessionItems.filter(
              (item) =>
                !remoteSessionsList.some((remote) => remote.id === item.id),
            ),
          ]
        : [...sessionItems, ...keptRemoteSessions];

      const total = small.length + big.length;
      const chatHash = hashString(JSON.stringify(chatMeta));
      const chatChanged =
        hashString(JSON.stringify(remoteIndex?.chat ?? null)) !== chatHash;

      // 会话顺序也算改动：侧边栏拖动的结果要能同步到云端索引
      const mergedIds = mergedSessions.map((item) => item.id).join(",");
      const remoteIds = remoteSessionsList.map((item) => item.id).join(",");
      const orderChanged = mergedIds !== remoteIds;

      if (total === 0 && !chatChanged && !orderChanged) {
        console.log("[Upstash] nothing changed, skip upload");
        return {
          uploaded: 0,
          skipped: considered,
          total: 0,
          deleted: purgeSessions.length,
        };
      }

      let done = 0;
      // 只统计真正要写上去的条数：进度条从 0/N 开始，不会再一上来就跳到大半
      const reportWrite = () => onProgress?.(done, total);

      const writeStartedAt = Date.now();
      const requestsBeforeWrite = requestCount;

      // 1. 小项按批 pipeline 写（并发跑，别一棒一棒等往返）
      const writeBatches = groupBatchesByEncoding(
        small,
        (item) => item.payload.length + item.key.length,
      );
      await runLimited(writeBatches, UPLOAD_CONCURRENCY, async (batch) => {
        throwIfAborted();
        await this.writeBatch(batch);
        done += batch.length;
        reportWrite();
      });

      // 2. 大项（会切片）仍然逐项并发写
      let cursor = 0;
      const worker = async () => {
        while (cursor < big.length) {
          throwIfAborted();
          const entry = big[cursor++];
          // 用实际写入结果回填 chunked：中文按字符数判断会错，
          // 索引说“没切片”但实际写成了分片，读端就永远读不到最新内容
          try {
            entry.item.chunked = await this.writeValue(
              entry.key,
              entry.payload,
            );
          } catch (e: any) {
            // 带上 key，日志里能看出是哪个会话卡住了（否则只有一句“上传失败”）
            throw new Error(
              `[Upstash] failed to upload ${entry.key}: ${e?.message ?? e}`,
            );
          }
          done += 1;
          reportWrite();
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.min(UPLOAD_CONCURRENCY, big.length) },
          worker,
        ),
      );

      // 2.5 清理格式切换后遗留的旧 key：
      // 会话变短时旧分片不会自动消失，云端就会一直躺着多余的块
      await runLimited(staleChunkKeys, UPLOAD_CONCURRENCY, async (key) => {
        throwIfAborted();
        const previous = Number(await this.redisGet(`${key}-n`)) || 0;
        if (previous > 0) await this.dropChunks(key, 0, previous);
      });
      await runLimited(stalePlainKeys, UPLOAD_CONCURRENCY, async (key) => {
        throwIfAborted();
        await this.pipeline([["DEL", key]]).catch(() => {});
      });

      // 2.6 用户勾选了「删除云端已不存在的会话」：把这些会话的数据一起删掉
      //     （索引里也已经排除它们，所以删完不会有残留引用）
      await runLimited(purgeSessions, UPLOAD_CONCURRENCY, async (item) => {
        throwIfAborted();
        const key = sessionKey(item.id);
        await this.pipeline([["DEL", key]]).catch(() => {});
        // 分片可能残留：按 -n 精确清，读不到再按上限兜底
        await this.sweepChunks(key);
      });

      const writeMs = Date.now() - writeStartedAt;

      // 3. 最后写索引：读端以索引为准，索引存在即代表数据齐全。
      // 取消时不写索引 → 远端索引保持旧状态，下次上传会自己补上。
      throwIfAborted();
      const encodeMs = writeStartedAt - startedAt - hashMs - indexMs;

      /**
       * stores 也要「本地 + 云端保留」合并。
       *
       * 以前这里直接用本地的 storeItems 覆盖索引：只要有一次上传没带某个 store
       * （例如旧版本不认识知识库这个额外 store，或者 extraStores 传参漏了），
       * 索引里的那条记录就被抹掉 —— 数据 key 还在云端，但下载时再也找不到，
       * 表现就是「上传过知识库，下载后本地还是空的」。
       */
      const localStoreIds = new Set(storeItems.map((item) => item.id));
      const keptRemoteStores = (remoteIndex?.stores ?? []).filter(
        (item) => item && item.id && !localStoreIds.has(item.id),
      );
      const mergedStores = [...storeItems, ...keptRemoteStores];

      const index: RemoteIndex = {
        // 3：chunked 改为按实际写入结果记录（旧版本用字符数判断，会标错）
        v: 3,
        updatedAt: Date.now(),
        chat: chatMeta,
        // 本地会话 + 云端保留的条目（上传从不删会话，见上面的 mergedSessions）
        sessions: mergedSessions,
        // 本地 store + 云端独有的 store（知识库就在这一类）
        stores: mergedStores,
        compress,
        ...(options?.extraIndex ?? {}),
      };
      // extraIndex 里传 undefined 表示删掉该字段（例如关闭加密）
      Object.keys(index).forEach((key) => {
        if ((index as any)[key] === undefined) delete (index as any)[key];
      });
      const indexBytes = JSON.stringify(index);
      const indexSetStartedAt = Date.now();
      await this.redisSet(indexKey, indexBytes);
      this.invalidateIndexCache();
      const indexSetMs = Date.now() - indexSetStartedAt;

      /**
       * 这次真正写上去的会话标题。
       * 「某条对话到底传没传」以前只能靠肉眼翻 key，这里直接列出来。
       */
      const sessionKeyPrefix = sessionKey("");
      const topicById = new Map<string, string>(
        localSessions.map((item) => [
          item.session.id,
          String(item.session.topic ?? ""),
        ]),
      );
      const uploadedTopics = [...small, ...big]
        .map((item) => item.key)
        .filter((key) => key.startsWith(sessionKeyPrefix))
        .map((key) => key.slice(sessionKeyPrefix.length))
        .map((id) => topicById.get(id) ?? id);

      console.log(
        `[Upstash] incremental upload: ${done}/${total} item(s) in ${
          Date.now() - startedAt
        }ms`,
        {
          // 各阶段耗时：网络读 / 本地哈希 / 压缩编码 / 数据写入 / 索引写入
          indexReadMs: indexMs,
          localHashMs: hashMs,
          encodeMs,
          writeMs,
          indexSetMs,
          // 这次实际上传的会话标题（没变被跳过的不列）
          sessionTopics: uploadedTopics,
          // 索引说已同步、但云端数据丢失，这次自动补传的会话
          repairedTopics: Array.from(repairedIds).map(
            (id) => topicById.get(id) ?? id,
          ),
          // 请求数与上行数据量：慢的时候先看这两个
          requests: requestCount,
          writeRequests: requestCount - requestsBeforeWrite,
          directRequests: directCount,
          proxyRequests: proxyCount,
          writtenChars: bytesOut,
          // 原始 JSON / 压缩后 payload：看压缩比
          rawChars: rawCharsToUpload,
          payloadChars: payloadCharsToUpload,
          ratio: Number(
            (rawCharsToUpload / Math.max(1, payloadCharsToUpload)).toFixed(2),
          ),
          // 写入阶段的有效上行速度（KB/s），慢不慢一眼就能看出来
          uploadKBps: Math.round(
            bytesOut / 1024 / Math.max(0.001, writeMs / 1000),
          ),
          indexBytes: indexBytes.length,
          // 云端 key 的构成：1 个索引 + 未分片的项各 1 个 key + 分片项的分片 key
          items: total,
          sessions: sessions.length,
          stores: storeNames.length,
          chunkKeys: chunkKeysWritten,
          chunkKB: chunkSizeKB,
          expectedKeys:
            1 +
            (total - big.filter((b) => b.item.chunked).length) +
            chunkKeysWritten,
          compress,
          nativeCompress: hasNativeCompression(),
          direct: preferDirect && !forceProxy,
          directCooldownMsLeft: Math.max(0, directCooldownUntil - Date.now()),
        },
      );
      return {
        uploaded: done,
        skipped: considered - total,
        total,
        deleted: purgeSessions.length,
      };
    },

    /**
     * 下载：
     * - 优先读 v2 索引；索引里带每项的哈希，和本地一致就完全跳过；
     * - 小项合并成一次 pipeline GET，大项/分片项单独读；
     * - 支持 gzip 压缩过的内容。
     */
    async download(
      localState?: any,
      onProgress?: (done: number, total: number) => void,
      options?: {
        forceFull?: boolean;
        /** 会话 JSON → 明文 JSON（加密时解密）；抛错代表解密失败 */
        decode?: (json: string) => Promise<string>;
        /** 会话 JSON → 增量哈希（加密时用 HMAC，必须和上传时一致） */
        hashSession?: (json: string) => Promise<string>;
        /**
         * 额外 store（比如知识库）的本地哈希。
         * 和索引里的 h 一致就跳过下载 —— 知识库有 1~2MB，白白重传很费时间。
         */
        extraStoreHashes?: Record<string, string>;
      },
    ) {
      const startedAt = Date.now();
      const forceFull = options?.forceFull === true;

      /**
       * 读出来的 payload → 会话对象。
       * 解密失败要往上抛（不能当成“解析失败”跳过），否则密码错了会静默丢会话。
       */
      const decodeSession = async (raw: string, gz?: boolean) => {
        const json = await decodePayload(raw, gz);
        if (!options?.decode) return JSON.parse(json);
        try {
          return JSON.parse(await options.decode(json));
        } catch (e) {
          throw new Error(`DECRYPT_FAILED ${e}`);
        }
      };

      // 索引请求先发出去，等它的时候顺带把本地哈希算完
      // （取消时同样不能留下未处理的 rejection，见 upload 里的说明）
      let indexAbortError: unknown = null;
      const indexPromise = this.readIndexRaw().catch((e) => {
        if (isAbortError(e)) {
          indexAbortError = e;
          return null;
        }
        return null;
      });

      const localList: any[] = localState?.[StoreKey.Chat]?.sessions ?? [];
      // 和上传一样：先把扫描进度显示出来，别让用户干等
      onProgress?.(0, localList.length);

      const hashStartedAt = Date.now();
      // 本地会话的哈希，用来判断哪些完全没变
      const localHashes = new Map<string, { hash: string; item: any }>();
      let scanned = 0;
      let lastYieldAt = Date.now();
      const yieldIfNeeded = async () => {
        if (Date.now() - lastYieldAt < 8) return;
        lastYieldAt = Date.now();
        await new Promise((resolve) => setTimeout(resolve, 0));
      };

      for (const session of localList) {
        const json = JSON.stringify(session);
        localHashes.set(session.id, {
          // 开了加密时，云端记的是明文 MAC，这里必须用同一种算法，
          // 否则“本地没改”的会话也会被判成不同、每次下载都全量拉
          hash: options?.hashSession
            ? await options.hashSession(json)
            : hashString(json),
          item: session,
        });
        onProgress?.(++scanned, localList.length);
        await yieldIfNeeded();
      }
      const hashMs = Date.now() - hashStartedAt;

      const indexRaw = await indexPromise;
      if (indexAbortError) throw indexAbortError;
      const indexMs = Date.now() - hashStartedAt - hashMs;

      if (indexRaw) {
        try {
          const index = JSON.parse(indexRaw) as RemoteIndex;
          const remoteSessions = index.sessions ?? [];
          const remoteStores = index.stores ?? [];

          const sessionsById = new Map<string, any>();
          const toFetch: RemoteItem[] = [];
          let skipped = 0;

          for (const item of remoteSessions) {
            const local = localHashes.get(item.id);
            if (!forceFull && item.h && local && local.hash === item.h) {
              sessionsById.set(item.id, local.item);
              skipped += 1;
            } else {
              toFetch.push(item);
            }
          }

          /**
           * 读失败时用本地副本兜底：
           * 下载是「整体覆盖本地」，某条会话一旦读不到就被丢掉的话，
           * 它在本地也会跟着消失（用户看到的就是“那条对话蒸发了”）。
           * 本地还有这份副本就先用它顶上，至少不会丢。
           */
          const fallbackToLocal = (item: RemoteItem, reason: string) => {
            const local = localHashes.get(item.id);
            if (local?.item) {
              console.warn(
                `[Upstash] ${reason}, falling back to the local copy:`,
                item.id,
                local.item?.topic,
              );
              sessionsById.set(item.id, local.item);
            } else {
              console.error(
                `[Upstash] ${reason}, and no local copy to fall back to:`,
                item.id,
              );
            }
          };

          // 小项合批读（并发跑），大项/分片项逐个读
          const smallItems = toFetch.filter(
            (item) =>
              !item.chunked &&
              typeof item.size === "number" &&
              item.size <= PIPELINE_MAX_CHARS,
          );
          const bigItems = toFetch.filter((item) => !smallItems.includes(item));

          // 只统计真正要拉取的条数：跳过的（本地已有相同内容）不计入，
          // 否则进度会从「跳过数/总数」开始，看着像一开始就快完成了
          const readTotal = smallItems.length + bigItems.length;
          let readDone = 0;
          const reportRead = () => onProgress?.(readDone, readTotal);
          reportRead();

          const readBatches = groupBatchesByEncoding(
            smallItems,
            (item) => item.size ?? 0,
          );
          await runLimited(readBatches, UPLOAD_CONCURRENCY, async (batch) => {
            const values = await this.readBatch(
              batch.map((item) => ({
                key: sessionKey(item.id),
                size: item.size ?? 0,
              })),
            );
            await Promise.all(
              batch.map(async (item) => {
                let raw = values.get(sessionKey(item.id));
                if (typeof raw !== "string" && !item.chunked) {
                  // 老版本把“按字节切片”的会话标成了不切片，这里补一次分片读取
                  raw = (await this.readValue(sessionKey(item.id), true).catch(
                    () => null,
                  )) as any;
                }
                if (typeof raw !== "string") {
                  fallbackToLocal(item, "missing session payload");
                  return;
                }
                try {
                  sessionsById.set(item.id, await decodeSession(raw, item.gz));
                } catch (e: any) {
                  if (String(e?.message ?? "").startsWith("DECRYPT_FAILED")) {
                    throw e;
                  }
                  fallbackToLocal(item, "failed to parse session");
                }
              }),
            );
            readDone += batch.length;
            reportRead();
          });

          await Promise.all(
            bigItems.map(async (item) => {
              const key = sessionKey(item.id);
              let raw = await this.readValue(key, item.chunked).catch((e) => {
                if (isAbortError(e)) throw e;
                return null;
              });
              if (!raw && !item.chunked) {
                // 同上：老索引可能把分片会话标成单 key
                raw = await this.readValue(key, true).catch(() => null);
              }
              if (!raw) {
                fallbackToLocal(item, "missing session in remote");
                readDone += 1;
                reportRead();
                return;
              }
              try {
                sessionsById.set(item.id, await decodeSession(raw, item.gz));
              } catch (e: any) {
                if (String(e?.message ?? "").startsWith("DECRYPT_FAILED")) {
                  throw e;
                }
                fallbackToLocal(item, "failed to parse session");
              }
              readDone += 1;
              reportRead();
            }),
          );

          // stores 一般都小，能合批就合批
          const stores: Record<string, any> = {};
          const storeToFetch = remoteStores.filter((item) => {
            if (forceFull) return true;
            // 额外 store（知识库）：本地哈希由调用方算好传进来
            const extra = options?.extraStoreHashes?.[item.id];
            if (extra !== undefined) {
              return !item.h || extra !== item.h;
            }
            const local = localState?.[item.id];
            if (!item.h || !local) return true;
            return hashString(JSON.stringify(local)) !== item.h;
          });
          const smallStores = storeToFetch.filter(
            (item) =>
              !item.chunked &&
              typeof item.size === "number" &&
              item.size <= PIPELINE_MAX_CHARS,
          );
          const bigStores = storeToFetch.filter(
            (item) => !smallStores.includes(item),
          );

          const storeValues = await this.readBatch(
            smallStores.map((item) => ({
              key: storeItemKey(item.id),
              size: item.size ?? 0,
            })),
          );
          await Promise.all(
            smallStores.map(async (item) => {
              const raw = storeValues.get(storeItemKey(item.id));
              if (typeof raw !== "string") return;
              try {
                stores[item.id] = JSON.parse(await decodePayload(raw, item.gz));
              } catch (e) {
                console.warn("[Upstash] failed to parse store", item.id);
              }
            }),
          );
          await Promise.all(
            bigStores.map(async (item) => {
              const raw = await this.readValue(
                storeItemKey(item.id),
                item.chunked,
              ).catch((e) => {
                if (isAbortError(e)) throw e;
                return null;
              });
              if (!raw) return;
              try {
                stores[item.id] = JSON.parse(await decodePayload(raw, item.gz));
              } catch (e) {
                console.warn("[Upstash] failed to parse store", item.id);
              }
            }),
          );

          const sessions = remoteSessions
            .map((item) => sessionsById.get(item.id))
            .filter(Boolean);

          // 下载完做一次对账：索引里有、结果里没有的会话要留下痕迹
          const missingIds = remoteSessions
            .filter((item) => !sessionsById.has(item.id))
            .map((item) => item.id);
          if (missingIds.length > 0) {
            console.error(
              "[Upstash] sessions missing after download:",
              missingIds,
            );
          }

          console.log(
            `[Upstash] download v2: ${sessions.length} session(s), ${
              Object.keys(stores).length
            } store(s), skipped ${skipped} unchanged in ${
              Date.now() - startedAt
            }ms`,
            {
              indexReadMs: indexMs,
              localHashMs: hashMs,
              dataMs: Date.now() - startedAt - indexMs - hashMs,
              direct: preferDirect && !forceProxy,
              directCooldownMsLeft: Math.max(
                0,
                directCooldownUntil - Date.now(),
              ),
              // 这次下载涉及的会话标题（跳过 + 实际拉取的都列出来）
              sessionTopics: sessions.map(
                (session: any) => session?.topic ?? "",
              ),
              fetchedTopics: toFetch.map(
                (item) => sessionsById.get(item.id)?.topic ?? item.id,
              ),
              missingIds,
            },
          );
          // 老索引里可能还留着 lastInput（草稿）：读的时候忽略，
          // 让本地输入框保持原样
          const remoteChatMeta: any = { ...index.chat };
          delete remoteChatMeta.lastInput;

          return {
            [StoreKey.Chat]: { ...remoteChatMeta, sessions },
            ...stores,
          };
        } catch (e) {
          if (isAbortError(e)) throw e;
          console.error("[Upstash] failed to read v2 index", e);
        }
      }

      // 老格式兜底
      const raw = await this.get();
      console.log("[Upstash] legacy download raw =", raw);
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch (e) {
        console.error("[Upstash] download parse failed", e);
        return null;
      }
    },

    /**
     * 读索引原文（10 秒内复用）。
     * 上传 / 下载 / 读加密参数都走这里，避免一次同步读两遍索引。
     */
    async readIndexRaw(): Promise<string | null> {
      const now = Date.now();
      if (indexRawCache && now - indexRawCache.at < INDEX_CACHE_MS) {
        return indexRawCache.raw;
      }
      const raw = (await this.redisGet(indexKey).catch(() => null)) ?? null;
      indexRawCache = { at: now, raw };
      return raw;
    },

    invalidateIndexCache() {
      indexRawCache = null;
    },

    /**
     * 只读索引里的小部分元信息（加密参数）。
     * 下载 / 同步前要先知道云端是不是加密的、用什么 salt，
     * 才能派生密钥并解密。
     */
    async readIndexMeta(): Promise<{ enc?: any } | null> {
      const raw = await this.readIndexRaw();
      if (!raw) return null;
      try {
        const index = JSON.parse(raw);
        return { enc: index?.enc ?? undefined };
      } catch {
        return null;
      }
    },

    /**
     * 清空当前用户名（UPSTASH_USERNAME / storeKey）下的全部云端数据。
     *
     * 只删 `<storeKey>-` 前缀的 key，不碰同一个库里别人的备份。
     * 先按索引逐个 key / 分片删，再尽量用 SCAN 扫一遍前缀，
     * 把索引里没记录的孤儿分片一起清掉。
     */
    async clearRemote(): Promise<number> {
      const keys = new Set<string>();
      /** 不带分片后缀的基础 key，用来做“暴力清扫” */
      const baseKeys = new Set<string>();

      // 1. 按索引收集：索引本身 + 每个会话/配置的 key 与分片
      const indexRaw = await this.redisGet(indexKey).catch(() => null);
      if (indexRaw) {
        try {
          const index = JSON.parse(indexRaw) as RemoteIndex;
          const collect = async (
            items: RemoteItem[],
            keyOf: (id: string) => string,
          ) => {
            for (const item of items) {
              const key = keyOf(item.id);
              keys.add(key);
              baseKeys.add(key);
              if (item.chunked) {
                const count = Number(await this.redisGet(`${key}-n`)) || 0;
                for (let i = 0; i < count; i++) keys.add(`${key}-c${i}`);
                keys.add(`${key}-n`);
              }
            }
          };
          await collect(index.sessions ?? [], sessionKey);
          await collect(index.stores ?? [], storeItemKey);
        } catch (e) {
          console.warn("[Upstash] failed to parse index while clearing", e);
        }
      }

      keys.add(indexKey);

      // 2. 老格式（整包分片）
      const legacyCount = Number(await this.redisGet(legacyCountKey)) || 0;
      for (let i = 0; i < legacyCount; i++) keys.add(legacyChunkKey(i));
      keys.add(legacyCountKey);

      // 3. 扫一遍前缀：索引里没记录的孤儿 key 也一起删
      let scanned = 0;
      const scannedKeys: string[] = [];
      try {
        for (const key of await this.scanKeys(`${storeKey}-`)) {
          keys.add(key);
          scannedKeys.push(key);
          scanned += 1;
        }
      } catch (e) {
        console.warn("[Upstash] failed to scan keys while clearing", e);
      }
      console.log(
        "[Upstash] clear: index keys =",
        keys.size,
        "scanned =",
        scanned,
      );
      if (scannedKeys.length) {
        // 打印出来，方便和 Upstash 控制台核对到底有哪些 key
        console.log("[Upstash] remote keys:", scannedKeys);
      }

      // 4. 兜底：把已知项的 `-n` 和分片一起删。
      //    分片数按 `-n` 的记录精确取，读不到再按 MAX_CHUNK_SWEEP 兜底，
      //    避免 key 列表因为上限太大而膨胀。
      for (const base of baseKeys) {
        keys.add(`${base}-n`);
        const recorded = Number(await this.redisGet(`${base}-n`)) || 0;
        const count = recorded > 0 ? recorded : MAX_CHUNK_SWEEP;
        for (let i = 0; i < count; i++) keys.add(`${base}-c${i}`);
      }

      /**
       * 5. 一次性删掉。
       *
       * Redis 的 DEL 支持一次带多个 key，把 100 个 key 塞进一条 DEL 命令，
       * 每条 pipeline 再带 5 条命令 → 上千个 key 只需要几个请求。
       * 之前是「一个 key 一条命令、每批 40 条」，900 多个 key 要跑二十多个
       * 请求，用户看到的就是“数据库已经空了，前端还在转”。
       */
      const list = Array.from(keys);
      const KEYS_PER_COMMAND = 100;
      const commands: string[][] = [];
      for (let i = 0; i < list.length; i += KEYS_PER_COMMAND) {
        commands.push(["DEL", ...list.slice(i, i + KEYS_PER_COMMAND)]);
      }

      const COMMANDS_PER_PIPELINE = 5;
      for (let i = 0; i < commands.length; i += COMMANDS_PER_PIPELINE) {
        throwIfAborted();
        await this.pipeline(commands.slice(i, i + COMMANDS_PER_PIPELINE));
      }

      console.log("[Upstash] cleared remote keys:", list.length);
      return list.length;
    },

    /** 按前缀列出 key：优先 KEYS（一次请求），失败再退回 SCAN */
    async scanKeys(prefix: string): Promise<string[]> {
      const found: string[] = [];
      const pattern = `${encodeURIComponent(prefix)}*`;

      // 1. KEYS —— 简单直接，管理型操作，数据量不大时完全够用
      try {
        const res = await this.request({
          path: `keys/${pattern}`,
          action: "keys",
          key: pattern,
          method: "GET",
          headers: this.headers(),
          signal,
        });
        if (res.ok) {
          const body = await res.json().catch(() => null);
          if (Array.isArray(body)) {
            console.log("[Upstash] KEYS returned", body.length, "key(s)");
            return body.map(String);
          }
        } else {
          console.warn("[Upstash] KEYS not allowed:", res.status);
        }
      } catch (e) {
        console.warn("[Upstash] KEYS failed, try SCAN", e);
      }

      // 2. SCAN 兜底
      let cursor = "0";

      for (let page = 0; page < 50; page++) {
        const path = `scan/${cursor}/match/${encodeURIComponent(
          prefix,
        )}*/count/500`;
        const res = await this.request({
          path,
          action: "scan",
          key: `${cursor}/match/${encodeURIComponent(prefix)}*/count/500`,
          method: "GET",
          headers: this.headers(),
          signal,
        });
        if (!res.ok) break;

        const body = await res.json().catch(() => null);
        // Upstash 返回 [nextCursor, [key1, key2, ...]]
        if (!Array.isArray(body)) break;
        const [next, batch] = body as [string | number, string[]];
        if (Array.isArray(batch)) {
          found.push(...batch.map(String));
        }
        if (next === undefined || next === null || String(next) === "0") break;
        cursor = String(next);
      }

      return found;
    },

    /**
     * 列出**同一个数据库里**的所有备份名。
     *
     * 备份名就是 key 前缀（`<name>-v2-index` / 老格式 `<name>-chunk-count`），
     * 也就是设置里「索引名 / UPSTASH_USERNAME」那一栏。同一个 Upstash 库被
     * 多个部署共用、或者改过索引名时，旧数据会以别的前缀留在库里——
     * 这个接口把它们找出来，供「从数据库导入其它备份」使用。
     */
    async listBackupNames(): Promise<string[]> {
      const keys = await this.scanKeys("");
      const names = new Set<string>();

      for (const key of keys) {
        const v2 = key.match(/^(.*)-v2-index$/);
        if (v2 && v2[1]) {
          names.add(v2[1]);
          continue;
        }
        const legacy = key.match(/^(.*)-chunk-count$/);
        if (legacy && legacy[1]) {
          names.add(legacy[1]);
          continue;
        }
        // 有些库只有老格式的整包 key，没有 chunk-count
        const legacyBase = key.match(/^(.*)-chunk-0$/);
        if (legacyBase && legacyBase[1]) names.add(legacyBase[1]);
      }

      return [...names].sort();
    },
  };
}
