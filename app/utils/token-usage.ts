/**
 * token 用量：把各家 API 的 usage 归一化成一个形状，便于在消息上展示。
 *
 * 两种来源（都在 DeepSeek 文档里）：
 *   - Chat Completions：{ prompt_tokens, completion_tokens, total_tokens,
 *       prompt_tokens_details.cached_tokens, completion_tokens_details.reasoning_tokens }
 *   - Responses API：{ input_tokens, output_tokens, total_tokens,
 *       input_tokens_details.cached_tokens, output_tokens_details.reasoning_tokens }
 */

export type TokenUsage = {
  /** 输入 token 数 */
  promptTokens?: number;
  /** 输出 token 数（含思维链） */
  completionTokens?: number;
  totalTokens?: number;
  /** 命中上下文缓存的输入 token 数 */
  cachedTokens?: number;
  /** 思维链 token 数 */
  reasoningTokens?: number;
};

type RawUsage = Record<string, any> | null | undefined;

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * 归一化 usage。
 * @param raw API 返回的 usage 对象（两种命名都认）
 * @returns 无有效数据时返回 undefined
 */
export function normalizeTokenUsage(raw: RawUsage): TokenUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;

  const promptTokens = num(raw.prompt_tokens) ?? num(raw.input_tokens);
  const completionTokens = num(raw.completion_tokens) ?? num(raw.output_tokens);
  const cachedTokens =
    num(raw.prompt_tokens_details?.cached_tokens) ??
    num(raw.prompt_cache_hit_tokens) ??
    num(raw.input_tokens_details?.cached_tokens);
  const reasoningTokens =
    num(raw.completion_tokens_details?.reasoning_tokens) ??
    num(raw.output_tokens_details?.reasoning_tokens);
  const totalTokens =
    num(raw.total_tokens) ??
    (promptTokens !== undefined || completionTokens !== undefined
      ? (promptTokens ?? 0) + (completionTokens ?? 0)
      : undefined);

  const usage: TokenUsage = {
    promptTokens,
    completionTokens,
    totalTokens,
    cachedTokens,
    reasoningTokens,
  };

  const hasAny = Object.values(usage).some((value) => value !== undefined);
  return hasAny ? usage : undefined;
}

/** 追加到消息时间后面的总量，例如 `1,234 tokens` */
export function formatTokenTotal(totalTokens: number): string {
  return `${Math.max(0, Math.round(totalTokens)).toLocaleString(
    "en-US",
  )} tokens`;
}

/**
 * 悬停提示的明细：输入 / 输出（缓存命中、思维链按需补充）。
 * @param usage 归一化后的用量
 */
export function formatTokenDetail(
  usage: TokenUsage,
  labels: {
    prompt: string;
    completion: string;
    cached: string;
    reasoning: string;
    total: string;
  },
): string {
  const lines: string[] = [];

  if (usage.promptTokens !== undefined) {
    let line = `${labels.prompt}: ${formatTokenTotal(usage.promptTokens)}`;
    if (usage.cachedTokens) {
      line += ` (${labels.cached} ${usage.cachedTokens.toLocaleString(
        "en-US",
      )})`;
    }
    lines.push(line);
  }

  if (usage.completionTokens !== undefined) {
    let line = `${labels.completion}: ${formatTokenTotal(
      usage.completionTokens,
    )}`;
    if (usage.reasoningTokens) {
      line += ` (${labels.reasoning} ${usage.reasoningTokens.toLocaleString(
        "en-US",
      )})`;
    }
    lines.push(line);
  }

  if (usage.totalTokens !== undefined) {
    lines.push(`${labels.total}: ${formatTokenTotal(usage.totalTokens)}`);
  }

  return lines.join("\n");
}
