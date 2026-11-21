import {
  GoogleSafetySettingsThreshold,
  ServiceProvider,
  StoreKey,
  ApiPath,
  OPENAI_BASE_URL,
  ANTHROPIC_BASE_URL,
  GEMINI_BASE_URL,
  BAIDU_BASE_URL,
  BYTEDANCE_BASE_URL,
  ALIBABA_BASE_URL,
  TENCENT_BASE_URL,
  MOONSHOT_BASE_URL,
  STABILITY_BASE_URL,
  IFLYTEK_BASE_URL,
  DEEPSEEK_BASE_URL,
  XAI_BASE_URL,
  CHATGLM_BASE_URL,
  SILICONFLOW_BASE_URL,
  AI302_BASE_URL,
} from "../constant";
import { getHeaders } from "../client/api";
import { getClientConfig } from "../config/client";
import { createPersistStore } from "../utils/store";
import { ensure } from "../utils/clone";
import { DEFAULT_CONFIG } from "./config";
import {
  getModelProvider,
  inferProviderName,
  resolveProviderName,
} from "../utils/model";

let fetchState = 0; // 0 not fetch, 1 fetching, 2 done

/**
 * 服务器配置（/api/config）缓存。
 *
 * 这份配置是构建/部署时确定的，几乎不会变。原来每次打开都要 POST 一次
 * /api/config，在跨境链路上就是白白多等几秒；缓存一份到 localStorage 后
 * 首屏直接用旧值，新值后台再覆盖。
 */
const SERVER_CONFIG_CACHE_KEY = "server-config-cache";

function readCachedServerConfig(): DangerConfig | null {
  try {
    const raw = window.localStorage.getItem(SERVER_CONFIG_CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as DangerConfig;
  } catch {
    return null;
  }
}

function writeCachedServerConfig(config: DangerConfig) {
  try {
    window.localStorage.setItem(
      SERVER_CONFIG_CACHE_KEY,
      JSON.stringify(config ?? {}),
    );
  } catch {
    // 隐私模式下写不进去，忽略即可
  }
}

const isApp = getClientConfig()?.buildMode === "export";

const DEFAULT_OPENAI_URL = isApp ? OPENAI_BASE_URL : ApiPath.OpenAI;

const DEFAULT_GOOGLE_URL = isApp ? GEMINI_BASE_URL : ApiPath.Google;

const DEFAULT_ANTHROPIC_URL = isApp ? ANTHROPIC_BASE_URL : ApiPath.Anthropic;

const DEFAULT_BAIDU_URL = isApp ? BAIDU_BASE_URL : ApiPath.Baidu;

const DEFAULT_BYTEDANCE_URL = isApp ? BYTEDANCE_BASE_URL : ApiPath.ByteDance;

const DEFAULT_ALIBABA_URL = isApp ? ALIBABA_BASE_URL : ApiPath.Alibaba;

const DEFAULT_TENCENT_URL = isApp ? TENCENT_BASE_URL : ApiPath.Tencent;

const DEFAULT_MOONSHOT_URL = isApp ? MOONSHOT_BASE_URL : ApiPath.Moonshot;

const DEFAULT_STABILITY_URL = isApp ? STABILITY_BASE_URL : ApiPath.Stability;

const DEFAULT_IFLYTEK_URL = isApp ? IFLYTEK_BASE_URL : ApiPath.Iflytek;

const DEFAULT_DEEPSEEK_URL = isApp ? DEEPSEEK_BASE_URL : ApiPath.DeepSeek;

const DEFAULT_XAI_URL = isApp ? XAI_BASE_URL : ApiPath.XAI;

const DEFAULT_CHATGLM_URL = isApp ? CHATGLM_BASE_URL : ApiPath.ChatGLM;

const DEFAULT_SILICONFLOW_URL = isApp
  ? SILICONFLOW_BASE_URL
  : ApiPath.SiliconFlow;

const DEFAULT_AI302_URL = isApp ? AI302_BASE_URL : ApiPath["302.AI"];

const DEFAULT_ACCESS_STATE = {
  accessCode: "",
  useCustomConfig: false,
  /**
   * 直连 DeepSeek：用本机的 API Key 直接从浏览器访问 api.deepseek.com，
   * 不经过本项目的服务器（DeepSeek 允许跨域）。
   * 只影响 DeepSeek，不会像 useCustomConfig 那样牵连其它服务商。
   */
  deepseekDirect: false,

  provider: ServiceProvider.OpenAI,

  // openai
  openaiUrl: DEFAULT_OPENAI_URL,
  openaiApiKey: "",

  // azure
  azureUrl: "",
  azureApiKey: "",
  azureApiVersion: "2023-08-01-preview",

  // google ai studio
  googleUrl: DEFAULT_GOOGLE_URL,
  googleApiKey: "",
  googleApiVersion: "v1",
  googleSafetySettings: GoogleSafetySettingsThreshold.BLOCK_ONLY_HIGH,

  // anthropic
  anthropicUrl: DEFAULT_ANTHROPIC_URL,
  anthropicApiKey: "",
  anthropicApiVersion: "2023-06-01",

  // baidu
  baiduUrl: DEFAULT_BAIDU_URL,
  baiduApiKey: "",
  baiduSecretKey: "",

  // bytedance
  bytedanceUrl: DEFAULT_BYTEDANCE_URL,
  bytedanceApiKey: "",

  // alibaba
  alibabaUrl: DEFAULT_ALIBABA_URL,
  alibabaApiKey: "",

  // moonshot
  moonshotUrl: DEFAULT_MOONSHOT_URL,
  moonshotApiKey: "",

  //stability
  stabilityUrl: DEFAULT_STABILITY_URL,
  stabilityApiKey: "",

  // tencent
  tencentUrl: DEFAULT_TENCENT_URL,
  tencentSecretKey: "",
  tencentSecretId: "",

  // iflytek
  iflytekUrl: DEFAULT_IFLYTEK_URL,
  iflytekApiKey: "",
  iflytekApiSecret: "",

  // deepseek
  deepseekUrl: DEFAULT_DEEPSEEK_URL,
  deepseekApiKey: "",

  // xai
  xaiUrl: DEFAULT_XAI_URL,
  xaiApiKey: "",

  // chatglm
  chatglmUrl: DEFAULT_CHATGLM_URL,
  chatglmApiKey: "",

  // siliconflow
  siliconflowUrl: DEFAULT_SILICONFLOW_URL,
  siliconflowApiKey: "",

  // 302.AI
  ai302Url: DEFAULT_AI302_URL,
  ai302ApiKey: "",

  // server config
  needCode: true,
  hideUserApiKey: false,
  hideBalanceQuery: false,
  disableGPT4: false,
  disableFastLink: false,
  customModels: "",
  defaultModel: "",
  visionModels: "",

  // tts config
  edgeTTSVoiceName: "zh-CN-YunxiNeural",
};

export const useAccessStore = createPersistStore(
  { ...DEFAULT_ACCESS_STATE },

  (set, get) => ({
    enabledAccessControl() {
      this.fetch();

      return get().needCode;
    },
    getVisionModels() {
      this.fetch();
      return get().visionModels;
    },
    edgeVoiceName() {
      this.fetch();

      return get().edgeTTSVoiceName;
    },

    isValidOpenAI() {
      return ensure(get(), ["openaiApiKey"]);
    },

    isValidAzure() {
      return ensure(get(), ["azureUrl", "azureApiKey", "azureApiVersion"]);
    },

    isValidGoogle() {
      return ensure(get(), ["googleApiKey"]);
    },

    isValidAnthropic() {
      return ensure(get(), ["anthropicApiKey"]);
    },

    isValidBaidu() {
      return ensure(get(), ["baiduApiKey", "baiduSecretKey"]);
    },

    isValidByteDance() {
      return ensure(get(), ["bytedanceApiKey"]);
    },

    isValidAlibaba() {
      return ensure(get(), ["alibabaApiKey"]);
    },

    isValidTencent() {
      return ensure(get(), ["tencentSecretKey", "tencentSecretId"]);
    },

    isValidMoonshot() {
      return ensure(get(), ["moonshotApiKey"]);
    },
    isValidIflytek() {
      return ensure(get(), ["iflytekApiKey"]);
    },
    isValidDeepSeek() {
      return ensure(get(), ["deepseekApiKey"]);
    },

    isValidXAI() {
      return ensure(get(), ["xaiApiKey"]);
    },

    isValidChatGLM() {
      return ensure(get(), ["chatglmApiKey"]);
    },

    isValidSiliconFlow() {
      return ensure(get(), ["siliconflowApiKey"]);
    },

    isAuthorized() {
      this.fetch();

      // has token or has code or disabled access control
      return (
        this.isValidOpenAI() ||
        this.isValidAzure() ||
        this.isValidGoogle() ||
        this.isValidAnthropic() ||
        this.isValidBaidu() ||
        this.isValidByteDance() ||
        this.isValidAlibaba() ||
        this.isValidTencent() ||
        this.isValidMoonshot() ||
        this.isValidIflytek() ||
        this.isValidDeepSeek() ||
        this.isValidXAI() ||
        this.isValidChatGLM() ||
        this.isValidSiliconFlow() ||
        !this.enabledAccessControl() ||
        (this.enabledAccessControl() && ensure(get(), ["accessCode"]))
      );
    },
    fetch() {
      if (fetchState > 0 || getClientConfig()?.buildMode === "export") return;
      fetchState = 1;

      // 先用上次缓存的服务器配置（本地秒开，不用等这一趟网络）
      const cached = readCachedServerConfig();
      if (cached) {
        console.log("[Config] using cached server config");
        set(() => ({ ...cached }));
      }

      fetch("/api/config", {
        method: "post",
        body: null,
        headers: {
          ...getHeaders(),
        },
      })
        .then((res) => res.json())
        .then((res) => {
          const defaultModel = res.defaultModel ?? "";
          if (defaultModel !== "") {
            const [model, providerId] = getModelProvider(defaultModel);
            DEFAULT_CONFIG.modelConfig.model = model;
            /**
             * 服务端 `defaultModel` 里写的是 provider **id**（`deepseek-chat@deepseek`），
             * 而 modelConfig.providerName 必须是 ServiceProvider 的枚举值（"DeepSeek"）。
             * 以前直接 `providerName as any`，于是新会话把请求发到了 /api/openai，
             * 服务端模型白名单（-all,+deepseek-chat@deepseek）判定不允许 → 403。
             */
            const resolved =
              resolveProviderName(providerId) ?? inferProviderName(model);
            if (resolved) DEFAULT_CONFIG.modelConfig.providerName = resolved;
          }

          return res;
        })
        .then((res: DangerConfig) => {
          console.log("[Config] got config from server", res);
          writeCachedServerConfig(res);
          set(() => ({ ...res }));
        })
        .catch(() => {
          console.error("[Config] failed to fetch config");
        })
        .finally(() => {
          fetchState = 2;
        });
    },
  }),
  {
    name: StoreKey.Access,
    version: 2,
    migrate(persistedState, version) {
      if (version < 2) {
        const state = persistedState as {
          token: string;
          openaiApiKey: string;
          azureApiVersion: string;
          googleApiKey: string;
        };
        state.openaiApiKey = state.token;
        state.azureApiVersion = "2023-08-01-preview";
      }

      return persistedState as any;
    },
  },
);
