import { ApiPath, STORAGE_KEY, StoreKey } from "../constant";
import { createPersistStore } from "../utils/store";
import {
  AppState,
  getLocalAppState,
  GetStoreState,
  mergeAppState,
  setLocalAppState,
} from "../utils/sync";
import { downloadAs, readFromFile } from "../utils";
import { showToast } from "../components/ui-lib";
import Locale from "../locales";
import { createSyncClient, ProviderType } from "../utils/cloud";

export interface WebDavConfig {
  server: string;
  username: string;
  password: string;
}

export type SyncStore = GetStoreState<typeof useSyncStore>;

const DEFAULT_SYNC_STATE = {
  provider: ProviderType.WebDAV,
  useProxy: true,
  proxyUrl: ApiPath.Cors as string,

  /**
   * 是否把内容 gzip 压缩后再上传。
   * 原生 CompressionStream 可用时走原生（快），否则用 fflate（纯 JS，
   * iOS 15 等老设备也能解压），所以默认开启：文本类备份通常能小 3~5 倍。
   */
  useCompression: true,

  webdav: {
    endpoint: "",
    username: "",
    password: "",
  },

  upstash: {
    endpoint: "",
    username: STORAGE_KEY,
    apiKey: "",
  },

  lastSyncTime: 0,
  lastProvider: "",
  // 上传 / 下载分别记录时间（原版只有一个「同步」按钮，靠 lastSyncTime 记录）
  lastUploadTime: 0,
  lastDownloadTime: 0,
};

export const useSyncStore = createPersistStore(
  DEFAULT_SYNC_STATE,
  (set, get) => ({
    cloudSync() {
      const config = get()[get().provider];
      return Object.values(config).every((c) => c.toString().length > 0);
    },

    markSyncTime() {
      set({ lastSyncTime: Date.now(), lastProvider: get().provider });
    },

    markUploadTime() {
      set({ lastUploadTime: Date.now() });
    },

    markDownloadTime() {
      set({ lastDownloadTime: Date.now() });
    },

    export() {
      const state = getLocalAppState();
      // toLocaleString() 里带 "/" 和 ":"，在 Windows 上是非法文件名字符，
      // 统一替换掉，避免浏览器把文件名改写甚至下载失败
      const datePart = new Date()
        .toLocaleString()
        .replace(/[/\\:*?"<>|]/g, "_");

      const fileName = `Backup-${datePart}.json`;
      downloadAs(JSON.stringify(state), fileName);
    },

    async import() {
      const rawContent = await readFromFile();

      try {
        // 备份常常是手工用编辑器改过的，可能带 UTF-8 BOM（Windows 记事本默认），
        // JSON.parse 会直接报错，这里先去掉
        const remoteState = JSON.parse(
          rawContent.replace(/^\uFEFF/, ""),
        ) as AppState;
        const localState = getLocalAppState();
        // 导入备份：同 id 的消息以备份为准，否则备份里的修改会被本地旧内容吃掉
        mergeAppState(localState, remoteState, true);
        setLocalAppState(localState);
        // 持久化是异步写 IndexedDB 的，立刻 reload 有可能把刚导入的数据丢掉
        // （低配设备上尤其明显），这里先给写入留一点时间
        setTimeout(() => location.reload(), 500);
      } catch (e) {
        console.error("[Import]", e);
        showToast(Locale.Settings.Sync.ImportFailed);
      }
    },

    getClient() {
      const provider = get().provider;
      const client = createSyncClient(provider, get());
      return client;
    },

    async sync() {
      const localState = getLocalAppState();
      const provider = get().provider;
      const config = get()[provider];
      const client = this.getClient();

      try {
        const remoteState = await client.get(config.username);
        if (!remoteState || remoteState === "") {
          await client.set(config.username, JSON.stringify(localState));
          console.log(
            "[Sync] Remote state is empty, using local state instead.",
          );
          return;
        } else {
          // 这里原来又 get 了一次，白白多拉一遍全量数据
          const parsedRemoteState = JSON.parse(remoteState) as AppState;
          mergeAppState(localState, parsedRemoteState);
          setLocalAppState(localState);
        }
      } catch (e) {
        console.log("[Sync] failed to get remote state", e);
        throw e;
      }

      await client.set(config.username, JSON.stringify(localState));

      this.markSyncTime();
    },

    async check() {
      const client = this.getClient();
      return await client.check();
    },
  }),
  {
    name: StoreKey.Sync,
    version: 1.3,

    migrate(persistedState, version) {
      const newState = persistedState as typeof DEFAULT_SYNC_STATE;

      if (version < 1.1) {
        newState.upstash.username = STORAGE_KEY;
      }

      if (version < 1.2) {
        if (
          (persistedState as typeof DEFAULT_SYNC_STATE).proxyUrl ===
          "/api/cors/"
        ) {
          newState.proxyUrl = "";
        }
      }

      // 1.3：压缩现在有纯 JS 兜底（fflate），老设备也能解压，默认开启；
      // 不想用的可以在同步配置里关掉
      if (version < 1.3) {
        newState.useCompression = true;
      }

      return newState as any;
    },
  },
);
