import { STORAGE_KEY } from "@/app/constant";
import { SyncStore } from "@/app/store/sync";
import { chunks } from "../format";

export type UpstashConfig = SyncStore["upstash"];
export type UpStashClient = ReturnType<typeof createUpstashClient>;

/**
 * 并发上传的分片数。
 * 原来的实现是一片一片串行 await，跨洋链路上 N 片就是 N 个往返；
 * 适度并发（不要太高，否则弱网下反而更慢）能把总耗时压到接近单次往返。
 */
const UPLOAD_CONCURRENCY = 4;

export function createUpstashClient(store: SyncStore) {
  const config = store.upstash;
  const storeKey = config.username.length === 0 ? STORAGE_KEY : config.username;
  const chunkCountKey = `${storeKey}-chunk-count`;
  const chunkIndexKey = (i: number) => `${storeKey}-chunk-${i}`;

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

    async get() {
      const chunkCount = Number(await this.redisGet(chunkCountKey));
      if (!Number.isInteger(chunkCount)) return;

      const chunks = await Promise.all(
        new Array(chunkCount)
          .fill(0)
          .map((_, i) => this.redisGet(chunkIndexKey(i))),
      );
      console.log("[Upstash] get full chunks", chunks);
      return chunks.join("");
    },

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
          await this.redisSet(chunkIndexKey(index), parts[index]);
          done += 1;
          onProgress?.(done, total);
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(UPLOAD_CONCURRENCY, total) }, worker),
      );

      // 分片全部写完后再写总数，保证读取端不会读到半截数据
      await this.redisSet(chunkCountKey, total.toString());

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
    async download() {
      const raw = await this.get();
      console.log("[Upstash] download raw =", raw);
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch (e) {
        console.error("[Upstash] download parse failed", e);
        return null;
      }
    },
    async upload(
      state: any,
      onProgress?: (done: number, total: number) => void,
    ) {
      const raw = JSON.stringify(state);
      console.log("[Upstash] upload size =", raw.length);
      await this.set("", raw, onProgress);
      console.log("[Upstash] upload done");
    },
  };
}
