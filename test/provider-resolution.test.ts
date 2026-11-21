import { getClientApi } from "../app/client/api";
import { ServiceProvider } from "../app/constant";
import { inferProviderName, resolveProviderName } from "../app/utils/model";

/**
 * 回归测试：服务端 `defaultModel: "deepseek-chat@deepseek"` 里的 provider 是
 * provider **id**，不是 `ServiceProvider` 的枚举值。
 *
 * 早前的代码把它原样写进 `modelConfig.providerName`，于是 `getClientApi()`
 * 匹配不到任何分支、落到默认的 GPT 客户端，请求发到 /api/openai，
 * 服务端模型白名单（-all,+deepseek-chat@deepseek）判定
 * `deepseek-chat@openai` 不可用 → 新会话第一条消息报
 * "you are not allowed to use deepseek-chat model"。
 */
describe("resolveProviderName", () => {
  test("provider id → 枚举值", () => {
    expect(resolveProviderName("deepseek")).toBe(ServiceProvider.DeepSeek);
    expect(resolveProviderName("moonshot")).toBe(ServiceProvider.Moonshot);
    expect(resolveProviderName("xai")).toBe(ServiceProvider.XAI);
    expect(resolveProviderName("chatglm")).toBe(ServiceProvider.ChatGLM);
  });

  test("已经是枚举值时原样返回（大小写不敏感）", () => {
    expect(resolveProviderName("DeepSeek")).toBe(ServiceProvider.DeepSeek);
    expect(resolveProviderName("deepseek")).toBe(ServiceProvider.DeepSeek);
    expect(resolveProviderName("OpenAI")).toBe(ServiceProvider.OpenAI);
    expect(resolveProviderName("openai")).toBe(ServiceProvider.OpenAI);
  });

  test("未知 / 空值返回 undefined", () => {
    expect(resolveProviderName(undefined)).toBeUndefined();
    expect(resolveProviderName("")).toBeUndefined();
    expect(resolveProviderName("not-a-provider")).toBeUndefined();
  });
});

describe("inferProviderName", () => {
  test("只看模型名也能推断服务商", () => {
    expect(inferProviderName("deepseek-chat")).toBe(ServiceProvider.DeepSeek);
    expect(inferProviderName("deepseek-reasoner")).toBe(
      ServiceProvider.DeepSeek,
    );
  });

  test("未知模型返回 undefined（不瞎猜）", () => {
    expect(inferProviderName("some-custom-model")).toBeUndefined();
  });
});

describe("getClientApi 的兼容处理", () => {
  test("传 provider id 也会选到正确的平台（不再落到 GPT）", () => {
    const api = getClientApi("deepseek" as unknown as ServiceProvider);
    // path() 由具体平台实现，LLMApi 接口里没有声明
    const path = (api.llm as any).path("chat/completions") as string;
    expect(path).toContain("/api/deepseek");
    expect(path).not.toContain("/api/openai");
  });

  test("正常枚举值不受影响", () => {
    const api = getClientApi(ServiceProvider.DeepSeek);
    expect((api.llm as any).path("chat/completions")).toContain(
      "/api/deepseek",
    );
  });
});
