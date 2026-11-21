import { StoreKey } from "../../constant";
import type { ChatSession } from "../../store/chat";
import type { SyncStore } from "../../store/sync";
import { createUpstashClient } from "./upstash";
import { ensureBundle, makeDecodeHook } from "../crypto-flow";
import {
  prepareSessionForImport,
  toImportCandidates,
} from "./backup-candidates";

export { prepareSessionForImport, toImportCandidates };

/**
 * 从「同一个数据库里的其它备份」导入会话。
 *
 * 备份名 = key 前缀（设置里的索引名 / UPSTASH_USERNAME）。同一份 Upstash 库
 * 如果被多个部署共用、或者改过索引名，旧数据就会以别的前缀留在库里。
 * 这里可以：列出全部备份名 → 读指定备份 → 勾选会话 → 导入本地。
 *
 * 加密备份沿用同步那套流程：先读该备份的索引元信息拿到 KDF 参数，
 * 本机没有对应钥匙时弹窗要密码（`ensureBundle`），解密失败会报错而不是静默丢数据。
 */

export type RemoteBackupSession = {
  session: ChatSession;
  /** 与本地已有会话 id 冲突时用的新 id */
  willRename: boolean;
};

/**
 * 列出数据库里所有备份名。
 * @param store 同步配置（endpoint / apiKey 等）
 */
export async function listRemoteBackups(store: SyncStore): Promise<string[]> {
  const client = createUpstashClient(store);
  return client.listBackupNames();
}

/**
 * 读取指定备份里的全部会话。
 *
 * @param store 同步配置
 * @param name 备份名（key 前缀）
 * @param options.localIds 本地已有的会话 id，用来标记哪些会重名
 */
export async function readRemoteBackup(
  store: SyncStore,
  name: string,
  options: { localIds?: string[]; signal?: AbortSignal } = {},
): Promise<{ sessions: ChatSession[]; encrypted: boolean }> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("EMPTY_BACKUP_NAME");

  // 指向目标前缀：其余配置（endpoint / apiKey / 代理 / 分片大小）保持不变
  const client = createUpstashClient(
    {
      ...store,
      upstash: { ...store.upstash, username: trimmed },
    },
    { signal: options.signal },
  );

  // 云端加密时这里会弹窗要密码（本机已有匹配的钥匙则直接复用）
  const bundle = await ensureBundle(client);

  const state = await client.download({}, undefined, {
    forceFull: true,
    decode: bundle ? makeDecodeHook(bundle) : undefined,
  });

  const sessions: ChatSession[] = Array.isArray(
    (state as any)?.[StoreKey.Chat]?.sessions,
  )
    ? (state as any)[StoreKey.Chat].sessions
    : [];

  return { sessions, encrypted: !!bundle };
}
