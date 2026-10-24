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

/** 上传缓存里的一项：内容哈希 + 上次是否切片存放 */
type CacheEntry = { h: string; chunked: boolean };

/**
 * 本地缓存：记录每个会话 / store 上次**上传成功**时的内容哈希。
 * 只存本地（localStorage），不上云，用来判断“哪些块变了”。
 */
type UploadCache = {
  sessions: Record<string, CacheEntry>;
  stores: Record<string, CacheEntry>;
  chat: CacheEntry | null;
};

/** 远程索引里的一项 */
type RemoteItem = { id: string; chunked: boolean };

/**
 * 远程索引（v2）：
 * - 会话、配置按 key 分开存，上传时可以只传变化的那些；
 * - 索引最后写，保证读端不会读到半截数据。
 */
type RemoteIndex = {
  v: number;
  updatedAt: number;
  /** chat store 里除 sessions 之外的字段 */
  chat: Record<string, any>;
  sessions: RemoteItem[];
  stores: RemoteItem[];
};

const CACHE_PREFIX = "upstash-upload-cache-";

function emptyCache(): UploadCache {
  return { sessions: {}, stores: {}, chat: null };
}

function readCache(key: string): UploadCache {
  try {
    if (typeof window === "undefined") return emptyCache();
    const raw = window.localStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return emptyCache();
    const parsed = JSON.parse(raw) as Partial<UploadCache>;
    return {
      sessions: parsed.sessions ?? {},
      stores: parsed.stores ?? {},
      chat: parsed.chat ?? null,
    };
  } catch (e) {
    console.warn("[Upstash] failed to read upload cache", e);
    return emptyCache();
  }
}

function writeCache(key: string, cache: UploadCache) {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(cache));
  } catch (e) {
    console.warn("[Upstash] failed to write upload cache", e);
  }
}

/** 清掉上传缓存：下次上传会把所有内容重传一遍 */
export function clearUpstashUploadCache(storeKey?: string) {
  try {
    if (typeof window === "undefined") return;
    if (storeKey) {
      window.localStorage.removeItem(CACHE_PREFIX + storeKey);
      return;
    }
    Object.keys(window.localStorage)
      .filter((k) => k.startsWith(CACHE_PREFIX))
      .forEach((k) => window.localStorage.removeItem(k));
  } catch (e) {
    console.warn("[Upstash] failed to clear upload cache", e);
  }
}

export function createUpstashClient(store: SyncStore) {
  const config = store.upstash;
  const storeKey = config.username.length === 0 ? STORAGE_KEY : config.username;

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
      });

      console.log("[Upstash] get key = ", key, res.status, res.statusText);
      const resJson = (await res.json()) as { result: string };

      return resJson.result;
    },

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
     * 逐会话 / 逐 store 计算内容哈希，只上传和上次成功上传时不一样的部分。
     * “哪些变了”由哈希比较得出，不需要在每个改消息的地方打脏标记——那样
     * 少标一处就会静默漏传。
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

      // 远端没有索引（换了库 / 云端被清空）时，本地缓存不可信，全部重传
      let cache = readCache(storeKey);
      try {
        if (!(await this.redisGet(indexKey))) {
          cache = emptyCache();
        }
      } catch (e) {
        console.warn("[Upstash] failed to read index, upload everything", e);
        cache = emptyCache();
      }

      const nextCache: UploadCache = {
        sessions: { ...cache.sessions },
        stores: { ...cache.stores },
        chat: cache.chat,
      };

      const sessionChunked: Record<string, boolean> = {};
      const storeChunked: Record<string, boolean> = {};
      const tasks: Array<{
        key: string;
        value: string;
        onDone: (chunked: boolean) => void;
      }> = [];

      // 1. 会话：内容没变的直接跳过
      for (const session of sessions) {
        const json = JSON.stringify(session);
        const hash = hashString(json);
        const cached = cache.sessions[session.id];
        if (cached && cached.h === hash) {
          sessionChunked[session.id] = cached.chunked;
          continue;
        }
        tasks.push({
          key: sessionKey(session.id),
          value: json,
          onDone: (chunked) => {
            sessionChunked[session.id] = chunked;
            nextCache.sessions[session.id] = { h: hash, chunked };
          },
        });
      }

      // 2. 其它 store（配置/密钥/面具/提示词）体积都很小，变了才传
      for (const name of storeNames) {
        const json = JSON.stringify(state[name] ?? {});
        const hash = hashString(json);
        const cached = cache.stores[name];
        if (cached && cached.h === hash) {
          storeChunked[name] = cached.chunked;
          continue;
        }
        tasks.push({
          key: storeItemKey(name),
          value: json,
          onDone: (chunked) => {
            storeChunked[name] = chunked;
            nextCache.stores[name] = { h: hash, chunked };
          },
        });
      }

      const total = tasks.length;
      const considered = sessions.length + storeNames.length;
      const chatHash = hashString(JSON.stringify(chatMeta));
      const chatChanged = cache.chat?.h !== chatHash;
      if (total === 0 && !chatChanged) {
        console.log("[Upstash] nothing changed, skip upload");
        return { uploaded: 0, skipped: considered, total: 0 };
      }

      // 3. 并发写入变化的项
      let cursor = 0;
      let done = 0;
      const worker = async () => {
        while (cursor < total) {
          const task = tasks[cursor++];
          const chunked = await this.writeValue(task.key, task.value);
          task.onDone(chunked);
          done += 1;
          onProgress?.(done, total);
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(UPLOAD_CONCURRENCY, total) }, worker),
      );

      // 4. 最后写索引：读端以索引为准，索引存在即代表数据齐全
      const index: RemoteIndex = {
        v: 2,
        updatedAt: Date.now(),
        chat: chatMeta,
        sessions: sessions.map((s) => ({
          id: s.id,
          chunked: !!sessionChunked[s.id],
        })),
        stores: storeNames.map((name) => ({
          id: name,
          chunked: !!storeChunked[name],
        })),
      };
      await this.redisSet(indexKey, JSON.stringify(index));

      // 5. 只有全部成功才更新本地缓存，失败下次会重传
      const aliveIds = new Set(sessions.map((s) => s.id));
      Object.keys(nextCache.sessions).forEach((id) => {
        if (!aliveIds.has(id)) delete nextCache.sessions[id];
      });
      nextCache.chat = { h: chatHash, chunked: false };
      writeCache(storeKey, nextCache);

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
     * 下载：优先读 v2 索引（增量格式），没有则回退到老的整包格式。
     */
    async download() {
      const indexRaw = await this.redisGet(indexKey).catch(() => null);
      if (indexRaw) {
        try {
          const index = JSON.parse(indexRaw) as RemoteIndex;
          const sessions = (
            await Promise.all(
              index.sessions.map(async (item) => {
                const raw = await this.readValue(
                  sessionKey(item.id),
                  item.chunked,
                );
                if (!raw) {
                  console.warn("[Upstash] missing session in remote", item.id);
                  return null;
                }
                try {
                  return JSON.parse(raw);
                } catch (e) {
                  console.warn("[Upstash] failed to parse session", item.id);
                  return null;
                }
              }),
            )
          ).filter(Boolean);

          const stores: Record<string, any> = {};
          await Promise.all(
            index.stores.map(async (item) => {
              const raw = await this.readValue(
                storeItemKey(item.id),
                item.chunked,
              );
              if (!raw) return;
              try {
                stores[item.id] = JSON.parse(raw);
              } catch (e) {
                console.warn("[Upstash] failed to parse store", item.id);
              }
            }),
          );

          console.log(
            `[Upstash] download v2: ${sessions.length} session(s), ${
              Object.keys(stores).length
            } store(s)`,
          );
          return {
            [StoreKey.Chat]: { ...index.chat, sessions },
            ...stores,
          };
        } catch (e) {
          console.error("[Upstash] failed to read v2 index", e);
        }
      }

      // 老格式兜底
      const raw = await this.get();
      console.log("[Upstash] download legacy raw =", raw);
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
