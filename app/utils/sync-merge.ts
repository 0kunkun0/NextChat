import { StoreKey } from "../constant";
import { hashString } from "./format";
import type { AppState } from "./sync";

/**
 * 「同步」（双向合并）的规划与执行。
 *
 * 单靠上传 / 下载只能二选一：要么用本机的副本，要么用云端的副本。
 * 多设备交替编辑时，总有一边的改动会被丢弃。
 *
 * 这里按会话粒度做三方比较：
 * - 每台机器记一份「上次同步时每个会话的哈希」（localSyncedHashes）；
 * - 本轮本地哈希 ≠ 上次哈希 → 本地改过；
 * - 云端哈希 ≠ 上次哈希 → 云端改过；
 * - 只有一边改过 → 直接用改过的那边；
 * - 两边都改过且内容不同 → **冲突**，交给用户逐个选择。
 *
 * 从没同步过（没有基线）时不弹一堆冲突：直接比 lastUpdate，新的赢。
 */

export type ConflictChoice = "local" | "remote";

export interface SessionBrief {
  id: string;
  topic: string;
  lastUpdate: number;
  messageCount: number;
  /** 最后一条 user 内容（截断后用于展示） */
  lastUser: string;
  /** 最后一条 assistant 内容（截断后用于展示） */
  lastAssistant: string;
}

export interface SyncConflict {
  id: string;
  local: SessionBrief;
  remote: SessionBrief;
}

export interface SyncPlan {
  /** 两边完全一样 */
  identical: string[];
  /** 只有本地有（新会话） */
  localOnly: string[];
  /** 只有云端有（别的设备新建的） */
  remoteOnly: string[];
  /** 本地改过、云端没动 */
  localChanged: string[];
  /** 云端改过、本地没动 */
  remoteChanged: string[];
  /** 两边都改过，需要用户选 */
  conflicts: SyncConflict[];
}

export function sessionHash(session: any): string {
  return hashString(JSON.stringify(session ?? null));
}

/** 构造「上次同步快照」：sessionId -> hash */
export function buildSyncedHashes(sessions: any[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const session of sessions ?? []) {
    if (session?.id) map[session.id] = sessionHash(session);
  }
  return map;
}

function timeOf(session: any): number {
  const raw = session?.lastUpdate;
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber) && raw !== "" && raw !== null) return asNumber;
  const parsed = new Date(raw ?? 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function preview(content: any, max = 120): string {
  const text =
    typeof content === "string"
      ? content
      : content === undefined || content === null
      ? ""
      : JSON.stringify(content);
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

export function briefOf(session: any): SessionBrief {
  const messages: any[] = Array.isArray(session?.messages)
    ? session.messages
    : [];
  const lastOf = (role: string) => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === role) return preview(messages[i].content);
    }
    return "";
  };

  return {
    id: String(session?.id ?? ""),
    topic: String(session?.topic ?? ""),
    lastUpdate: timeOf(session),
    messageCount: messages.length,
    lastUser: lastOf("user"),
    lastAssistant: lastOf("assistant"),
  };
}

/** 比较本地 / 云端，得出每个会话该怎么处理 */
export function planSync(
  local: AppState,
  remote: AppState,
  lastSynced: Record<string, string> = {},
): SyncPlan {
  const localSessions: any[] = local?.[StoreKey.Chat]?.sessions ?? [];
  const remoteSessions: any[] = remote?.[StoreKey.Chat]?.sessions ?? [];

  const localMap = new Map(localSessions.map((s) => [s.id, s]));
  const remoteMap = new Map(remoteSessions.map((s) => [s.id, s]));

  const plan: SyncPlan = {
    identical: [],
    localOnly: [],
    remoteOnly: [],
    localChanged: [],
    remoteChanged: [],
    conflicts: [],
  };

  for (const [id, localSession] of localMap) {
    const remoteSession = remoteMap.get(id);
    if (!remoteSession) {
      plan.localOnly.push(id);
      continue;
    }

    const localHash = sessionHash(localSession);
    const remoteHash = sessionHash(remoteSession);
    if (localHash === remoteHash) {
      plan.identical.push(id);
      continue;
    }

    const base = lastSynced?.[id];
    if (!base) {
      // 没有基线（第一次同步 / 老版本升级）：用最后更新时间判断，避免一上来就满屏冲突
      if (timeOf(localSession) >= timeOf(remoteSession)) {
        plan.localChanged.push(id);
      } else {
        plan.remoteChanged.push(id);
      }
      continue;
    }

    const localChanged = localHash !== base;
    const remoteChanged = remoteHash !== base;

    if (localChanged && remoteChanged) {
      plan.conflicts.push({
        id,
        local: briefOf(localSession),
        remote: briefOf(remoteSession),
      });
    } else if (localChanged) {
      plan.localChanged.push(id);
    } else if (remoteChanged) {
      plan.remoteChanged.push(id);
    } else {
      // 两边都和基线不同，却又互不相同（极少见）：按冲突处理更安全
      plan.conflicts.push({
        id,
        local: briefOf(localSession),
        remote: briefOf(remoteSession),
      });
    }
  }

  for (const id of remoteMap.keys()) {
    if (!localMap.has(id)) plan.remoteOnly.push(id);
  }

  return plan;
}

/**
 * 按用户的选择合并出一个新的 AppState。
 * 只处理「内容类」数据（会话 / 提示词 / 面具），不动 API Key 等设置。
 */
export function mergeByChoices(
  local: AppState,
  remote: AppState,
  plan: SyncPlan,
  choices: Record<string, ConflictChoice> = {},
): { state: AppState; syncedHashes: Record<string, string> } {
  const localSessions: any[] = local?.[StoreKey.Chat]?.sessions ?? [];
  const remoteSessions: any[] = remote?.[StoreKey.Chat]?.sessions ?? [];
  const remoteMap = new Map(remoteSessions.map((s) => [s.id, s]));

  const merged = new Map<string, any>(localSessions.map((s) => [s.id, s]));

  // 云端新增 / 云端改过而本地没动
  for (const id of [...plan.remoteOnly, ...plan.remoteChanged]) {
    const session = remoteMap.get(id);
    if (session) merged.set(id, session);
  }

  // 冲突：默认保留本地
  for (const conflict of plan.conflicts) {
    if ((choices[conflict.id] ?? "local") === "remote") {
      const session = remoteMap.get(conflict.id);
      if (session) merged.set(conflict.id, session);
    }
  }

  const sessions = Array.from(merged.values()).sort(
    (a, b) => timeOf(b) - timeOf(a),
  );

  const state: AppState = {
    ...local,
    [StoreKey.Chat]: { ...(local[StoreKey.Chat] as any), sessions },
  } as AppState;

  // 提示词 / 面具：取并集，同 id 以本地为准（和原来的合并逻辑一致）
  const localPrompts = (local as any)[StoreKey.Prompt]?.prompts ?? {};
  const remotePrompts = (remote as any)[StoreKey.Prompt]?.prompts ?? {};
  (state as any)[StoreKey.Prompt] = {
    ...(local as any)[StoreKey.Prompt],
    prompts: { ...remotePrompts, ...localPrompts },
  };

  const localMasks = (local as any)[StoreKey.Mask]?.masks ?? {};
  const remoteMasks = (remote as any)[StoreKey.Mask]?.masks ?? {};
  (state as any)[StoreKey.Mask] = {
    ...(local as any)[StoreKey.Mask],
    masks: { ...remoteMasks, ...localMasks },
  };

  return { state, syncedHashes: buildSyncedHashes(sessions) };
}
