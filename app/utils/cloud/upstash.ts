import { gzipSync, gunzipSync, strToU8, strFromU8 } from "fflate";
import { STORAGE_KEY, StoreKey } from "@/app/constant";
import { SyncStore } from "@/app/store/sync";
import { chunks, hashString } from "../format";

export type UpstashConfig = SyncStore["upstash"];
export type UpStashClient = ReturnType<typeof createUpstashClient>;

/**
 * 并发写切片的数量。
 * 原来的实现是一片一片串行 await，跨洋链路上 N 片就是 N 个往返；
 * 适度并发（不要太高，否则弱网下反而更慢）能把总耗时压到接近单次往返。
 */
const UPLOAD_CONCURRENCY = 6;
/** 单个 value 超过这个字节数才切片 */
const CHUNK_BYTES = 1000 * 1000;
/**
 * 单个 pipeline 请求里最多塞多少字符。
 * Upstash 单请求上限约 1MB，按 UTF-8 最坏 3 字节/字符算，25 万字符仍在上限内。
 */
const PIPELINE_MAX_CHARS = 250_000;
/**
 * 压缩过的内容是 base64（纯 ASCII，1 字符≈1 字节），
 * 同样的 1MB 上限可以塞更多，请求数能少 3 倍左右。
 */
const PIPELINE_MAX_CHARS_COMPRESSED = 800_000;
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
    await writer.write(new TextEncoder().encode(text));
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
    await writer.write(base64ToBytes(base64));
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
 * 直连失败过一次就记住（跨 client 实例、跨页面刷新），
 * 避免每次点同步都先撞一次跨域/超时再回退。
 */
const DIRECT_FLAG_KEY = "upstash-direct-unavailable";

function readDirectUnavailable() {
  try {
    return window.localStorage.getItem(DIRECT_FLAG_KEY) === "1";
  } catch {
    return false;
  }
}

function saveDirectUnavailable() {
  try {
    window.localStorage.setItem(DIRECT_FLAG_KEY, "1");
  } catch {
    // 隐私模式写不进去，至少本次会话内有效
  }
}

let directUnavailable =
  typeof window === "undefined" ? false : readDirectUnavailable();

/**
 * 直连最多等这么久。
 *
 * 有些网络环境访问 *.upstash.io 会一直卡在 TLS/连接阶段（不是立刻报错），
 * 不设超时的话第一次同步就得干等浏览器网络栈自己超时（好几秒甚至更久），
 * 之后再退回代理。这里主动掐断，快速回退。
 */
const DIRECT_TIMEOUT_MS = 2500;

export function createUpstashClient(
  store: SyncStore,
  options?: { signal?: AbortSignal },
) {
  const config = store.upstash;
  const storeKey = config.username.length === 0 ? STORAGE_KEY : config.username;
  /** 取消上传/下载用的信号：读请求立刻中断，写请求做完当前项再停 */
  const signal = options?.signal;

  /** 本次同步发出的 HTTP 请求数 / 上行字符数，用于排查“到底慢在哪” */
  let requestCount = 0;
  let bytesOut = 0;
  /** 直连 / 走代理的请求数；排查“是不是每次都在撞直连超时” */
  let directCount = 0;
  let proxyCount = 0;
  /** 实际要上传的原始 JSON 长度 / 压缩后长度，用来算压缩比 */
  let rawCharsToUpload = 0;
  let payloadCharsToUpload = 0;

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
      const res = await this.request({
        path: `set/${key}`,
        action: "set",
        key,
        method: "POST",
        headers: this.headers(),
        body: value,
      });

      console.log("[Upstash] set key = ", key, res.status, res.statusText);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Upstash set failed: ${res.status} ${text}`);
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

      if (!preferDirect || forceProxy || directUnavailable) {
        proxyCount += 1;
        return fetch(this.path(path, proxyUrl), init as RequestInit);
      }

      // 直连加超时：卡住的连接不要拖住整个同步
      let timedOut = false;
      const controller = new AbortController();
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, DIRECT_TIMEOUT_MS);
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
        // 记住这次失败（含页面刷新），别每次冷启动都再撞一次
        directUnavailable = true;
        saveDirectUnavailable();
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
      const parts = Array.from(chunks(value, CHUNK_BYTES));

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

      // 新的分片比旧的少：把越界的旧分片删掉
      if (previousCount > parts.length) {
        await this.dropChunks(key, parts.length, previousCount);
      }
      return true;
    },

    /** 删除 [from, to) 区间的旧分片（连同 -n），一次 pipeline 搞定 */
    async dropChunks(key: string, from: number, to: number) {
      const commands: string[][] = [];
      for (let i = from; i < to; i++) {
        commands.push(["DEL", `${key}-c${i}`]);
      }
      // from === 0 表示这条已经改回“不分片”，连 -n 一起删
      if (from === 0) commands.push(["DEL", `${key}-n`]);
      if (commands.length === 0) return;

      try {
        await this.pipeline(commands);
      } catch (e) {
        // 清理失败不影响数据正确性（读端以索引为准），忽略
        console.warn("[Upstash] failed to clean stale chunks", key, e);
      }
    },

    /** 读一个 value：单 key 或按索引里记录的分片数拼接 */
    async readValue(key: string, chunked: boolean): Promise<string | null> {
      if (!chunked) {
        return (await this.redisGet(key)) ?? null;
      }
      const count = Number(await this.redisGet(`${key}-n`));
      if (!Number.isInteger(count) || count <= 0) return null;

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
      options?: { forceFull?: boolean },
    ): Promise<{ uploaded: number; skipped: number; total: number }> {
      const startedAt = Date.now();
      const chat = state[StoreKey.Chat] ?? {};
      const sessions: any[] = Array.isArray(chat.sessions) ? chat.sessions : [];
      const { sessions: _sessions, ...chatMeta } = chat;
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
      const indexPromise = this.redisGet(indexKey).catch((e) => {
        if (isAbortError(e)) {
          indexAbortError = e;
          return null;
        }
        console.warn("[Upstash] failed to read index, upload everything", e);
        return null;
      });

      const considered = sessions.length + storeNames.length;
      // 一点按钮就把总条数报出去：用户立刻能看到 0/N 在动，
      // 而不是先干等「读索引 + 序列化」好几秒。
      onProgress?.(0, considered);

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
      for (const session of sessions) {
        throwIfAborted();
        const json = JSON.stringify(session);
        localSessions.push({ session, json, hash: hashString(json) });
        onProgress?.(++prepared, considered);
        await yieldIfNeeded();
      }

      const localStores = storeNames.map((name) => {
        const json = JSON.stringify(state[name] ?? {});
        return { name, json, hash: hashString(json) };
      });
      prepared += localStores.length;
      onProgress?.(prepared, considered);
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
        if (canSkipUnchanged && remote?.h === hash) {
          return {
            id,
            chunked: remote.chunked,
            gz: remote.gz,
            h: hash,
            size: remote.size ?? json.length,
          } as RemoteItem;
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
        if (payload.length > PIPELINE_MAX_CHARS) {
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
        sessionItems.push(
          await plan("sessions", item.session.id, item.json, item.hash),
        );
      }
      for (const item of localStores) {
        throwIfAborted();
        storeItems.push(await plan("stores", item.name, item.json, item.hash));
      }

      const total = small.length + big.length;
      const chatHash = hashString(JSON.stringify(chatMeta));
      const chatChanged =
        hashString(JSON.stringify(remoteIndex?.chat ?? null)) !== chatHash;
      if (total === 0 && !chatChanged) {
        console.log("[Upstash] nothing changed, skip upload");
        return { uploaded: 0, skipped: considered, total: 0 };
      }

      let done = 0;
      // 扫描阶段占了 considered 个进度，写阶段接着往上加，进度条只增不减
      const reportWrite = () =>
        onProgress?.(considered + done, considered + total);

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
          entry.item.chunked = await this.writeValue(entry.key, entry.payload);
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

      const writeMs = Date.now() - writeStartedAt;

      // 3. 最后写索引：读端以索引为准，索引存在即代表数据齐全。
      // 取消时不写索引 → 远端索引保持旧状态，下次上传会自己补上。
      throwIfAborted();
      const encodeMs = writeStartedAt - startedAt - hashMs - indexMs;
      const index: RemoteIndex = {
        // 3：chunked 改为按实际写入结果记录（旧版本用字符数判断，会标错）
        v: 3,
        updatedAt: Date.now(),
        chat: chatMeta,
        sessions: sessionItems,
        stores: storeItems,
        compress,
      };
      const indexBytes = JSON.stringify(index);
      const indexSetStartedAt = Date.now();
      await this.redisSet(indexKey, indexBytes);
      const indexSetMs = Date.now() - indexSetStartedAt;

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
          compress,
          nativeCompress: hasNativeCompression(),
          direct: preferDirect && !forceProxy,
        },
      );
      return {
        uploaded: done,
        skipped: considered - total,
        total,
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
      options?: { forceFull?: boolean },
    ) {
      const startedAt = Date.now();
      const forceFull = options?.forceFull === true;

      // 索引请求先发出去，等它的时候顺带把本地哈希算完
      // （取消时同样不能留下未处理的 rejection，见 upload 里的说明）
      let indexAbortError: unknown = null;
      const indexPromise = this.redisGet(indexKey).catch((e) => {
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
        localHashes.set(session.id, {
          hash: hashString(JSON.stringify(session)),
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

          // 小项合批读（并发跑），大项/分片项逐个读
          const smallItems = toFetch.filter(
            (item) =>
              !item.chunked &&
              typeof item.size === "number" &&
              item.size <= PIPELINE_MAX_CHARS,
          );
          const bigItems = toFetch.filter((item) => !smallItems.includes(item));

          // 跳过的项算“已完成”，进度条直接从跳过的数量起步
          const readTotal = remoteSessions.length;
          let readDone = skipped;
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
                if (typeof raw !== "string") return;
                try {
                  sessionsById.set(
                    item.id,
                    JSON.parse(await decodePayload(raw, item.gz)),
                  );
                } catch (e) {
                  console.warn("[Upstash] failed to parse session", item.id);
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
                console.warn("[Upstash] missing session in remote", item.id);
                return;
              }
              try {
                sessionsById.set(
                  item.id,
                  JSON.parse(await decodePayload(raw, item.gz)),
                );
              } catch (e) {
                console.warn("[Upstash] failed to parse session", item.id);
              }
              readDone += 1;
              reportRead();
            }),
          );

          // stores 一般都小，能合批就合批
          const stores: Record<string, any> = {};
          const storeToFetch = remoteStores.filter((item) => {
            if (forceFull) return true;
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
            },
          );
          return {
            [StoreKey.Chat]: { ...index.chat, sessions },
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
  };
}
