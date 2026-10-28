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
const UPLOAD_CONCURRENCY = 4;
/** 单个 value 超过这个字节数才切片 */
const CHUNK_BYTES = 1000 * 1000;
/**
 * 单个 pipeline 请求里最多塞多少字符。
 * Upstash 单请求上限约 1MB，按 UTF-8 最坏 3 字节/字符算，25 万字符仍在上限内。
 */
const PIPELINE_MAX_CHARS = 250_000;
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
function groupBatches<T>(items: T[], sizeOf: (item: T) => number) {
  const batches: T[][] = [];
  let current: T[] = [];
  let chars = 0;

  for (const item of items) {
    const size = sizeOf(item);
    if (
      current.length > 0 &&
      (current.length >= PIPELINE_MAX_COMMANDS ||
        chars + size > PIPELINE_MAX_CHARS)
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

/** 用户点了“取消”导致的错误（AbortController.abort） */
export function isAbortError(error: any) {
  return (
    error?.name === "AbortError" ||
    error?.code === 20 ||
    /aborted/i.test(String(error?.message ?? ""))
  );
}

export function createUpstashClient(
  store: SyncStore,
  options?: { signal?: AbortSignal },
) {
  const config = store.upstash;
  const storeKey = config.username.length === 0 ? STORAGE_KEY : config.username;
  /** 取消上传/下载用的信号：读请求立刻中断，写请求做完当前项再停 */
  const signal = options?.signal;

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

  return {
    async check() {
      try {
        const res = await fetch(this.path(`get/${storeKey}`, proxyUrl), {
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
      const res = await fetch(this.path(`get/${key}`, proxyUrl), {
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
      const res = await fetch(this.path(`set/${key}`, proxyUrl), {
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
      const res = await fetch(this.path("pipeline/_", proxyUrl), {
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

    /** 写一个 value：小内容单 key，大内容切片；返回是否切了片 */
    async writeValue(key: string, value: string): Promise<boolean> {
      const parts = Array.from(chunks(value, CHUNK_BYTES));
      if (parts.length <= 1) {
        await this.redisSet(key, value);
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
      return true;
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

      // 压缩是设置项，默认关闭；而且当前浏览器得真的支持 CompressionStream
      // （iOS 15 / Safari < 16.4 没有），否则按未压缩处理
      const compress = store.useCompression === true;

      // 读一次远端索引：
      // - 云端没有索引（换了库 / 被清空）→ 全部重传；
      // - 有的话用它里面的哈希判断哪些项没变（比本机缓存可靠，多设备也不会错）。
      let remoteIndex: RemoteIndex | null = null;
      try {
        const raw = await this.redisGet(indexKey);
        if (raw) remoteIndex = JSON.parse(raw) as RemoteIndex;
      } catch (e) {
        if (isAbortError(e)) throw e;
        console.warn("[Upstash] failed to read index, upload everything", e);
      }

      const remoteItems = new Map<string, RemoteItem>();
      for (const item of [
        ...(remoteIndex?.sessions ?? []),
        ...(remoteIndex?.stores ?? []),
      ]) {
        remoteItems.set(item.id, item);
      }

      // 压缩开关变了：之前的存储格式不再适用，所有项都要按新格式重写
      const reencodeAll =
        remoteIndex?.compress !== undefined &&
        remoteIndex.compress !== compress;

      const sessionItems: RemoteItem[] = [];
      const storeItems: RemoteItem[] = [];
      const small: Array<{ key: string; payload: string }> = [];
      const big: Array<{ key: string; payload: string }> = [];

      const plan = async (
        kind: "sessions" | "stores",
        id: string,
        json: string,
      ) => {
        const hash = hashString(json);
        const remote = remoteItems.get(id);

        // 远端已经有完全一样的内容：不重传，索引里沿用远端记录的存储方式
        if (!reencodeAll && remote?.h === hash) {
          return {
            id,
            chunked: remote.chunked,
            gz: remote.gz,
            h: hash,
            size: remote.size ?? json.length,
          } as RemoteItem;
        }

        const { payload, gz } = await encodePayload(json, compress);
        const item: RemoteItem = {
          id,
          chunked: payload.length > CHUNK_BYTES,
          gz,
          h: hash,
          size: payload.length,
        };

        const key = kind === "sessions" ? sessionKey(id) : storeItemKey(id);
        if (payload.length > PIPELINE_MAX_CHARS) {
          big.push({ key, payload });
        } else {
          small.push({ key, payload });
        }
        return item;
      };

      for (const session of sessions) {
        throwIfAborted();
        sessionItems.push(
          await plan("sessions", session.id, JSON.stringify(session)),
        );
      }
      for (const name of storeNames) {
        throwIfAborted();
        storeItems.push(
          await plan("stores", name, JSON.stringify(state[name] ?? {})),
        );
      }

      const total = small.length + big.length;
      const considered = sessions.length + storeNames.length;
      const chatHash = hashString(JSON.stringify(chatMeta));
      const chatChanged =
        hashString(JSON.stringify(remoteIndex?.chat ?? null)) !== chatHash;
      if (total === 0 && !chatChanged) {
        console.log("[Upstash] nothing changed, skip upload");
        return { uploaded: 0, skipped: considered, total: 0 };
      }

      let done = 0;

      // 1. 小项按批 pipeline 写
      for (const batch of groupBatches(
        small,
        (item) => item.payload.length + item.key.length,
      )) {
        throwIfAborted();
        await this.writeBatch(batch);
        done += batch.length;
        onProgress?.(done, total);
      }

      // 2. 大项（会切片）仍然逐项并发写
      let cursor = 0;
      const worker = async () => {
        while (cursor < big.length) {
          throwIfAborted();
          const item = big[cursor++];
          await this.writeValue(item.key, item.payload);
          done += 1;
          onProgress?.(done, total);
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.min(UPLOAD_CONCURRENCY, big.length) },
          worker,
        ),
      );

      // 3. 最后写索引：读端以索引为准，索引存在即代表数据齐全。
      // 取消时不写索引 → 远端索引保持旧状态，下次上传会自己补上。
      throwIfAborted();
      const index: RemoteIndex = {
        v: 2,
        updatedAt: Date.now(),
        chat: chatMeta,
        sessions: sessionItems,
        stores: storeItems,
        compress,
      };
      await this.redisSet(indexKey, JSON.stringify(index));

      console.log(
        `[Upstash] incremental upload: ${done}/${total} item(s) in ${
          Date.now() - startedAt
        }ms`,
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
    async download(localState?: any) {
      const indexRaw = await this.redisGet(indexKey).catch((e) => {
        if (isAbortError(e)) throw e;
        return null;
      });

      if (indexRaw) {
        try {
          const index = JSON.parse(indexRaw) as RemoteIndex;
          const remoteSessions = index.sessions ?? [];
          const remoteStores = index.stores ?? [];

          // 本地会话的哈希，用来判断哪些完全没变
          const localSessions = new Map<string, { hash: string; item: any }>();
          for (const session of localState?.[StoreKey.Chat]?.sessions ?? []) {
            localSessions.set(session.id, {
              hash: hashString(JSON.stringify(session)),
              item: session,
            });
          }

          const sessionsById = new Map<string, any>();
          const toFetch: RemoteItem[] = [];
          let skipped = 0;

          for (const item of remoteSessions) {
            const local = localSessions.get(item.id);
            if (item.h && local && local.hash === item.h) {
              sessionsById.set(item.id, local.item);
              skipped += 1;
            } else {
              toFetch.push(item);
            }
          }

          // 小项合批读，大项/分片项逐个读
          const smallItems = toFetch.filter(
            (item) =>
              !item.chunked &&
              typeof item.size === "number" &&
              item.size <= PIPELINE_MAX_CHARS,
          );
          const bigItems = toFetch.filter((item) => !smallItems.includes(item));

          for (const batch of groupBatches(
            smallItems,
            (item) => item.size ?? 0,
          )) {
            const values = await this.readBatch(
              batch.map((item) => ({
                key: sessionKey(item.id),
                size: item.size ?? 0,
              })),
            );
            await Promise.all(
              batch.map(async (item) => {
                const raw = values.get(sessionKey(item.id));
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
          }

          await Promise.all(
            bigItems.map(async (item) => {
              const raw = await this.readValue(
                sessionKey(item.id),
                item.chunked,
              ).catch((e) => {
                if (isAbortError(e)) throw e;
                return null;
              });
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
            }),
          );

          // stores 一般都小，能合批就合批
          const stores: Record<string, any> = {};
          const storeToFetch = remoteStores.filter((item) => {
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
            } store(s), skipped ${skipped} unchanged`,
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
