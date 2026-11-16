import { StoreKey } from "../constant";
import { useSyncStore } from "../store/sync";
import { createUpstashClient } from "./cloud/upstash";
import { ensureBundle, makePrepareHook } from "./crypto-flow";
import { getLocalAppState } from "./sync";
import { sessionHash } from "./sync-merge";

/**
 * 只上传当前这一条会话。
 *
 * 聊天界面右上角的「上传」按钮用它：改完一句话随手点一下，
 * 只传这一条（几十 KB），不用把几 MB 的历史全推一遍。
 *
 * 其它会话的索引条目会被原样保留，所以不会影响别处的数据。
 */
export async function uploadSessionNow(sessionId: string): Promise<{
  uploaded: number;
  skipped: number;
  total: number;
}> {
  if (!sessionId) throw new Error("missing session id");

  const syncStore = useSyncStore.getState();
  const client = createUpstashClient(syncStore);
  const state = getLocalAppState();

  // 云端开了加密就得先有密钥（必要时会弹密码框）
  const bundle = syncStore.encryption.enabled
    ? await ensureBundle(client)
    : null;
  if (syncStore.encryption.enabled && !bundle) {
    throw new Error("encryption-locked");
  }

  const stats = await client.upload(state, undefined, {
    sessionIds: [sessionId],
    prepare: bundle ? makePrepareHook(bundle) : undefined,
    extraIndex: bundle ? { enc: bundle.params } : undefined,
  });

  syncStore.markUploadTime();

  // 只更新这一条会话的同步基线，其它会话的基线保持不变
  const session = ((state?.[StoreKey.Chat]?.sessions ?? []) as any[]).find(
    (item) => item?.id === sessionId,
  );
  if (session) {
    syncStore.markSynced({
      ...(syncStore.lastSyncedHashes ?? {}),
      [sessionId]: sessionHash(session),
    });
  }

  return stats;
}
