import {
  formatTokenDetail,
  formatTokenTotal,
  normalizeTokenUsage,
} from "../app/utils/token-usage";

/**
 * token 用量展示。
 *
 * 文档里两套命名：
 *   - Chat Completions：prompt_tokens / completion_tokens / prompt_tokens_details.cached_tokens
 *   - Responses API：input_tokens / output_tokens / input_tokens_details.cached_tokens
 * 都要能归一化，然后在气泡时间后面显示「· 1,234 tokens」。
 */
describe("normalizeTokenUsage", () => {
  test("Chat Completions 形态", () => {
    expect(
      normalizeTokenUsage({
        prompt_tokens: 800,
        completion_tokens: 400,
        total_tokens: 1200,
        prompt_tokens_details: { cached_tokens: 300 },
        completion_tokens_details: { reasoning_tokens: 120 },
      }),
    ).toEqual({
      promptTokens: 800,
      completionTokens: 400,
      totalTokens: 1200,
      cachedTokens: 300,
      reasoningTokens: 120,
    });
  });

  test("Responses API 形态", () => {
    expect(
      normalizeTokenUsage({
        input_tokens: 500,
        output_tokens: 100,
        total_tokens: 600,
        input_tokens_details: { cached_tokens: 64 },
        output_tokens_details: { reasoning_tokens: 20 },
      }),
    ).toEqual({
      promptTokens: 500,
      completionTokens: 100,
      totalTokens: 600,
      cachedTokens: 64,
      reasoningTokens: 20,
    });
  });

  test("缺 total_tokens 时用输入+输出补", () => {
    expect(
      normalizeTokenUsage({ prompt_tokens: 3, completion_tokens: 4 }),
    ).toEqual({
      promptTokens: 3,
      completionTokens: 4,
      totalTokens: 7,
      cachedTokens: undefined,
      reasoningTokens: undefined,
    });
  });

  test("空 / 非法输入返回 undefined", () => {
    expect(normalizeTokenUsage(null)).toBeUndefined();
    expect(normalizeTokenUsage(undefined)).toBeUndefined();
    expect(normalizeTokenUsage({})).toBeUndefined();
  });
});

describe("formatTokenTotal / formatTokenDetail", () => {
  const labels = {
    prompt: "输入",
    completion: "输出",
    cached: "缓存命中",
    reasoning: "思维链",
    total: "合计",
  };

  test("总量带千分位", () => {
    expect(formatTokenTotal(1234)).toBe("1,234 tokens");
    expect(formatTokenTotal(0)).toBe("0 tokens");
  });

  test("明细包含输入/输出/缓存/思维链/合计", () => {
    const detail = formatTokenDetail(
      {
        promptTokens: 800,
        completionTokens: 400,
        totalTokens: 1200,
        cachedTokens: 300,
        reasoningTokens: 120,
      },
      labels,
    );

    expect(detail).toContain("输入: 800 tokens (缓存命中 300)");
    expect(detail).toContain("输出: 400 tokens (思维链 120)");
    expect(detail).toContain("合计: 1,200 tokens");
  });

  test("只有输入时不显示输出行", () => {
    const detail = formatTokenDetail({ promptTokens: 10 }, labels);
    expect(detail).toBe("输入: 10 tokens");
  });
});
