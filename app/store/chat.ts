import {
  getMessageTextContent,
  isDalle3,
  safeLocalStorage,
  trimTopic,
} from "../utils";

import { indexedDBStorage } from "@/app/utils/indexedDB-storage";
import { nanoid } from "nanoid";
import type {
  ClientApi,
  MultimodalContent,
  RequestMessage,
} from "../client/api";
import { getClientApi } from "../client/api";
import { ChatControllerPool } from "../client/controller";
import { showToast } from "../components/ui-lib";
import {
  DEFAULT_INPUT_TEMPLATE,
  DEFAULT_MODELS,
  DEFAULT_SYSTEM_TEMPLATE,
  GEMINI_SUMMARIZE_MODEL,
  DEEPSEEK_SUMMARIZE_MODEL,
  KnowledgeCutOffDate,
  MCP_SYSTEM_TEMPLATE,
  MCP_TOOLS_TEMPLATE,
  ServiceProvider,
  StoreKey,
  SUMMARIZE_MODEL,
} from "../constant";
import Locale, { getLang } from "../locales";
import { prettyObject } from "../utils/format";
import { createPersistStore } from "../utils/store";
import { estimateTokenLength } from "../utils/token";
import { ModelConfig, ModelType, useAppConfig } from "./config";
import { useAccessStore } from "./access";
import { collectModelsWithDefaultModel } from "../utils/model";
import { createEmptyMask, Mask } from "./mask";
import { executeMcpAction, getAllTools, isMcpEnabled } from "../mcp/actions";
import { extractMcpJson, isMcpJson } from "../mcp/utils";

const localStorage = safeLocalStorage();

export type ChatMessageTool = {
  id: string;
  index?: number;
  type?: string;
  function?: {
    name: string;
    arguments?: string;
  };
  content?: string;
  isError?: boolean;
  errorMsg?: string;
};

/**
 * 一条消息的一个候选回复。
 * 只保存“切换候选时会变化”的部分，结构性字段（id / role）放在外层消息上。
 */
export type ChatMessageVariant = {
  content: RequestMessage["content"];
  model?: ModelType;
  date: string;
  audio_url?: string;
  tools?: ChatMessageTool[];
  isError?: boolean;
};

export type ChatMessage = RequestMessage & {
  date: string;
  streaming?: boolean;
  isError?: boolean;
  id: string;
  model?: ModelType;
  tools?: ChatMessageTool[];
  audio_url?: string;
  isMcpResponse?: boolean;
  /**
   * 同一条消息的全部候选回复（包含当前生效的那一份）。
   * variantIndex 指向当前生效的候选，消息自身的 content / model / date
   * 始终与 variants[variantIndex] 保持同步，因此其它逻辑照旧直接读消息本体即可。
   */
  variants?: ChatMessageVariant[];
  variantIndex?: number;
  /**
   * 这条回复是否“生成完成”。
   * 未设置视为完成；标成 false 时说明内容可能只有一半（比如生成中途刷新），
   * 消息上会出现「继续生成」按钮，用前缀补全接着写。
   */
  isComplete?: boolean;
};

export function createMessage(override: Partial<ChatMessage>): ChatMessage {
  return {
    id: nanoid(),
    date: new Date().toLocaleString(),
    role: "user",
    content: "",
    ...override,
  };
}

/** 抽取一条消息里会随候选回复切换而变化的部分 */
export function snapshotMessage(message: ChatMessage): ChatMessageVariant {
  return {
    content: message.content,
    model: message.model,
    date: message.date,
    audio_url: message.audio_url,
    tools: message.tools,
    isError: message.isError,
  };
}

/** 消息的候选回复总数，没有候选数据时视为 1 */
export function getMessageVariantCount(message: ChatMessage) {
  return message.variants?.length ? message.variants.length : 1;
}

/** 当前显示的候选回复下标，从 0 开始 */
export function getMessageVariantIndex(message: ChatMessage) {
  const count = getMessageVariantCount(message);
  return Math.min(Math.max(message.variantIndex ?? 0, 0), count - 1);
}

/** 把候选回复的内容写回消息本体 */
export function applyMessageVariant(
  message: ChatMessage,
  variant: ChatMessageVariant,
) {
  message.content = variant.content;
  message.model = variant.model;
  message.date = variant.date ?? message.date;
  message.audio_url = variant.audio_url;
  message.tools = variant.tools;
  message.isError = variant.isError;
}

/**
 * 切换消息当前显示的候选回复（直接修改传入的消息）。
 * 切换前会先把消息当前内容写回快照，因此手动编辑过的内容不会丢。
 */
export function switchMessageVariant(message: ChatMessage, index: number) {
  const variants = message.variants?.length
    ? message.variants
    : [snapshotMessage(message)];
  const currentIndex = getMessageVariantIndex(message);
  const nextIndex = Math.min(Math.max(index, 0), variants.length - 1);

  // 保存当前候选（可能被编辑过）
  variants[currentIndex] = snapshotMessage(message);
  message.variants = variants;
  message.variantIndex = nextIndex;

  if (nextIndex !== currentIndex) {
    applyMessageVariant(message, variants[nextIndex]);
  }

  return message;
}

/**
 * 追加一个候选回复并切换过去，返回新候选的下标。
 * 原有回复会被保留为第 1 个候选。
 */
export function addMessageVariant(
  message: ChatMessage,
  variant: ChatMessageVariant,
) {
  const variants = message.variants?.length
    ? message.variants.slice()
    : [snapshotMessage(message)];

  variants.push(variant);
  message.variants = variants;
  message.variantIndex = variants.length - 1;
  applyMessageVariant(message, variant);

  return message.variantIndex;
}

export interface ChatStat {
  tokenCount: number;
  wordCount: number;
  charCount: number;
}

export interface ChatSession {
  id: string;
  topic: string;

  memoryPrompt: string;
  messages: ChatMessage[];
  stat: ChatStat;
  lastUpdate: number;
  lastSummarizeIndex: number;
  clearContextIndex?: number;

  mask: Mask;
}

export const DEFAULT_TOPIC = Locale.Store.DefaultTopic;
export const BOT_HELLO: ChatMessage = createMessage({
  role: "assistant",
  content: Locale.Store.BotHello,
});

function createEmptySession(): ChatSession {
  return {
    id: nanoid(),
    topic: DEFAULT_TOPIC,
    memoryPrompt: "",
    messages: [],
    stat: {
      tokenCount: 0,
      wordCount: 0,
      charCount: 0,
    },
    lastUpdate: Date.now(),
    lastSummarizeIndex: 0,

    mask: createEmptyMask(),
  };
}

function getSummarizeModel(
  currentModel: string,
  providerName: string,
): string[] {
  // if it is using gpt-* models, force to use 4o-mini to summarize
  if (currentModel.startsWith("gpt") || currentModel.startsWith("chatgpt")) {
    const configStore = useAppConfig.getState();
    const accessStore = useAccessStore.getState();
    const allModel = collectModelsWithDefaultModel(
      configStore.models,
      [configStore.customModels, accessStore.customModels].join(","),
      accessStore.defaultModel,
    );
    const summarizeModel = allModel.find(
      (m) => m.name === SUMMARIZE_MODEL && m.available,
    );
    if (summarizeModel) {
      return [
        summarizeModel.name,
        summarizeModel.provider?.providerName as string,
      ];
    }
  }
  if (currentModel.startsWith("gemini")) {
    return [GEMINI_SUMMARIZE_MODEL, ServiceProvider.Google];
  } else if (currentModel.startsWith("deepseek-")) {
    return [DEEPSEEK_SUMMARIZE_MODEL, ServiceProvider.DeepSeek];
  }

  return [currentModel, providerName];
}

function countMessages(msgs: ChatMessage[]) {
  return msgs.reduce(
    (pre, cur) => pre + estimateTokenLength(getMessageTextContent(cur)),
    0,
  );
}

function fillTemplateWith(input: string, modelConfig: ModelConfig) {
  const cutoff =
    KnowledgeCutOffDate[modelConfig.model] ?? KnowledgeCutOffDate.default;
  // Find the model in the DEFAULT_MODELS array that matches the modelConfig.model
  const modelInfo = DEFAULT_MODELS.find((m) => m.name === modelConfig.model);

  var serviceProvider = "OpenAI";
  if (modelInfo) {
    // TODO: auto detect the providerName from the modelConfig.model

    // Directly use the providerName from the modelInfo
    serviceProvider = modelInfo.provider.providerName;
  }

  const vars = {
    ServiceProvider: serviceProvider,
    cutoff,
    model: modelConfig.model,
    time: new Date().toString(),
    lang: getLang(),
    input: input,
  };

  let output = modelConfig.template ?? DEFAULT_INPUT_TEMPLATE;

  // remove duplicate
  if (input.startsWith(output)) {
    output = "";
  }

  // must contains {{input}}
  const inputVar = "{{input}}";
  if (!output.includes(inputVar)) {
    output += "\n" + inputVar;
  }

  Object.entries(vars).forEach(([name, value]) => {
    const regex = new RegExp(`{{${name}}}`, "g");
    output = output.replace(regex, value.toString()); // Ensure value is a string
  });

  return output;
}

async function getMcpSystemPrompt(): Promise<string> {
  const tools = await getAllTools();

  let toolsStr = "";

  tools.forEach((i) => {
    // error client has no tools
    if (!i.tools) return;

    toolsStr += MCP_TOOLS_TEMPLATE.replace(
      "{{ clientId }}",
      i.clientId,
    ).replace(
      "{{ tools }}",
      i.tools.tools.map((p: object) => JSON.stringify(p, null, 2)).join("\n"),
    );
  });

  return MCP_SYSTEM_TEMPLATE.replace("{{ MCP_TOOLS }}", toolsStr);
}

const DEFAULT_CHAT_STATE = {
  sessions: [createEmptySession()],
  currentSessionIndex: 0,
  lastInput: "",
};

export const useChatStore = createPersistStore(
  DEFAULT_CHAT_STATE,
  (set, _get) => {
    function get() {
      return {
        ..._get(),
        ...methods,
      };
    }

    const methods = {
      forkSession() {
        // 获取当前会话
        const currentSession = get().currentSession();
        if (!currentSession) return;

        const newSession = createEmptySession();

        newSession.topic = currentSession.topic;
        // 深拷贝消息
        newSession.messages = currentSession.messages.map((msg) => ({
          ...msg,
          id: nanoid(), // 生成新的消息 ID
          // 候选回复也要复制一份，避免两个会话共享同一份数组
          variants: msg.variants?.map((variant) => ({ ...variant })),
        }));
        newSession.mask = {
          ...currentSession.mask,
          modelConfig: {
            ...currentSession.mask.modelConfig,
          },
        };

        set((state) => ({
          currentSessionIndex: 0,
          sessions: [newSession, ...state.sessions],
        }));
      },

      clearSessions() {
        set(() => ({
          sessions: [createEmptySession()],
          currentSessionIndex: 0,
        }));
      },

      selectSession(index: number) {
        set({
          currentSessionIndex: index,
        });
      },

      moveSession(from: number, to: number) {
        set((state) => {
          const { sessions, currentSessionIndex: oldIndex } = state;

          // move the session
          const newSessions = [...sessions];
          const session = newSessions[from];
          newSessions.splice(from, 1);
          newSessions.splice(to, 0, session);

          // modify current session id
          let newIndex = oldIndex === from ? to : oldIndex;
          if (oldIndex > from && oldIndex <= to) {
            newIndex -= 1;
          } else if (oldIndex < from && oldIndex >= to) {
            newIndex += 1;
          }

          return {
            currentSessionIndex: newIndex,
            sessions: newSessions,
          };
        });
      },

      newSession(mask?: Mask) {
        const session = createEmptySession();

        if (mask) {
          const config = useAppConfig.getState();
          const globalModelConfig = config.modelConfig;

          session.mask = {
            ...mask,
            modelConfig: {
              ...globalModelConfig,
              ...mask.modelConfig,
            },
          };
          session.topic = mask.name;
        }

        set((state) => ({
          currentSessionIndex: 0,
          sessions: [session].concat(state.sessions),
        }));
      },

      nextSession(delta: number) {
        const n = get().sessions.length;
        const limit = (x: number) => (x + n) % n;
        const i = get().currentSessionIndex;
        get().selectSession(limit(i + delta));
      },

      deleteSession(index: number) {
        const deletingLastSession = get().sessions.length === 1;
        const deletedSession = get().sessions.at(index);

        if (!deletedSession) return;

        const sessions = get().sessions.slice();
        sessions.splice(index, 1);

        const currentIndex = get().currentSessionIndex;
        let nextIndex = Math.min(
          currentIndex - Number(index < currentIndex),
          sessions.length - 1,
        );

        if (deletingLastSession) {
          nextIndex = 0;
          sessions.push(createEmptySession());
        }

        // for undo delete action
        const restoreState = {
          currentSessionIndex: get().currentSessionIndex,
          sessions: get().sessions.slice(),
        };

        set(() => ({
          currentSessionIndex: nextIndex,
          sessions,
        }));

        showToast(
          Locale.Home.DeleteToast,
          {
            text: Locale.Home.Revert,
            onClick() {
              set(() => restoreState);
            },
          },
          5000,
        );
      },

      currentSession() {
        let index = get().currentSessionIndex;
        const sessions = get().sessions;

        if (index < 0 || index >= sessions.length) {
          index = Math.min(sessions.length - 1, Math.max(0, index));
          set(() => ({ currentSessionIndex: index }));
        }

        const session = sessions[index];

        return session;
      },

      onNewMessage(message: ChatMessage, targetSession: ChatSession) {
        get().updateTargetSession(targetSession, (session) => {
          session.messages = session.messages.concat();
          session.lastUpdate = Date.now();
        });

        get().updateStat(message, targetSession);

        get().checkMcpJson(message);

        get().summarizeSession(false, targetSession);
      },

      async onUserInput(
        content: string,
        attachImages?: string[],
        isMcpResponse?: boolean,
      ) {
        const session = get().currentSession();
        const modelConfig = session.mask.modelConfig;

        // MCP Response no need to fill template
        let mContent: string | MultimodalContent[] = isMcpResponse
          ? content
          : fillTemplateWith(content, modelConfig);

        if (!isMcpResponse && attachImages && attachImages.length > 0) {
          mContent = [
            ...(content ? [{ type: "text" as const, text: content }] : []),
            ...attachImages.map((url) => ({
              type: "image_url" as const,
              image_url: { url },
            })),
          ];
        }

        const userMessage: ChatMessage = createMessage({
          role: "user",
          content: mContent,
          isMcpResponse,
        });

        // 1. 先把 user 消息写进会话，再做任何可能失败的异步操作。
        //    历史组装要读 MCP（Next server action）、请求还要读模型配置，这些在
        //    低配/弱网环境里都可能抛错甚至把页面搞崩；先落库才能保证后面即使
        //    全部失败，用户发出去的话也还在。
        const historyEndIndex = session.messages.length;
        get().updateTargetSession(session, (session) => {
          session.messages = session.messages.concat([
            { ...userMessage, content: mContent },
          ]);
          session.lastUpdate = Date.now();
        });

        // 回复始终紧跟在它对应的 user 消息后面。
        // 历史组装较慢时用户可能已经发了下一条，直接 push 到末尾会把顺序搞乱。
        const insertReply = (reply: ChatMessage) => {
          get().updateTargetSession(session, (target) => {
            const index = target.messages.findIndex(
              (m) => m.id === userMessage.id,
            );
            const messages = target.messages.slice();
            // 必须换一个新数组，否则依赖 session.messages 引用的 useMemo 不会重算
            messages.splice(index >= 0 ? index + 1 : messages.length, 0, reply);
            target.messages = messages;
          });
        };

        // 2. 先插入占位回复：用户一点发送就能看到“正在输入”，也能立刻按停止。
        //    历史组装可能要读 MCP 提示词 / 记忆摘要，慢的时候要等好几秒，
        //    以前这段时间里界面上什么都没有，想停止都无从下手。
        const botMessage: ChatMessage = createMessage({
          role: "assistant",
          streaming: true,
          model: modelConfig.model,
        });

        insertReply(botMessage);

        // 3. 组装要发给模型的历史。
        //    只取新增消息之前的部分（historyEndIndex），否则会把这条 user 消息发两遍。
        let sendMessages: RequestMessage[];
        try {
          const recentMessages =
            await get().getMessagesWithMemory(historyEndIndex);
          sendMessages = recentMessages.concat(userMessage);
        } catch (error) {
          // 用户已经点了停止：直接把占位删掉，不必再报错
          // （注意先判断再 remove，remove 会把取消标记清掉）
          if (ChatControllerPool.isCancelled(session.id, botMessage.id)) {
            ChatControllerPool.remove(session.id, botMessage.id);
            get().updateTargetSession(session, (target) => {
              target.messages = target.messages.filter(
                (m) => m.id !== botMessage.id,
              );
            });
            return;
          }

          ChatControllerPool.remove(session.id, botMessage.id);
          console.error("[Chat] failed to assemble messages", error);
          // user 消息已经保存了，这里补一条错误回复：用户能看到失败原因，
          // 也能直接点它下面的「重新生成」重试，不用重新输入。
          get().updateTargetSession(session, (target) => {
            const index = target.messages.findIndex(
              (m) => m.id === botMessage.id,
            );
            if (index < 0) return;

            const messages = target.messages.slice();
            messages[index] = createMessage({
              role: "assistant",
              isError: true,
              content: prettyObject({
                error: true,
                message: `failed to send: ${
                  (error as Error)?.message ?? error
                }`,
              }),
            });
            target.messages = messages;
          });
          return;
        }

        // 4. 准备阶段就点了停止：收尾，不要真的发请求
        if (ChatControllerPool.isCancelled(session.id, botMessage.id)) {
          ChatControllerPool.remove(session.id, botMessage.id);
          get().updateTargetSession(session, (target) => {
            target.messages = target.messages.filter(
              (m) => m.id !== botMessage.id,
            );
          });
          return;
        }

        // 5. 发起请求
        get().chatWithApi({
          session,
          sendMessages,
          modelConfig,
          botMessage,
          flush() {
            get().updateTargetSession(session, (session) => {
              session.messages = session.messages.concat();
            });
          },
          onFinishMessage(message) {
            get().onNewMessage(message, session);
          },
          onError(error, isAborted) {
            userMessage.isError = !isAborted;
          },
        });
      },

      /**
       * 发起一次模型请求，并把流式结果写进 botMessage。
       * botMessage 既可以是新消息，也可以是某条消息新增的候选回复，
       * 调用方通过 flush 把最新内容同步到界面上。
       */
      chatWithApi(options: {
        session: ChatSession;
        sendMessages: RequestMessage[];
        modelConfig: ModelConfig;
        botMessage: ChatMessage;
        /** 用于停止/重试的控制器的 key，默认使用 botMessage.id */
        trackingId?: string;
        flush: () => void;
        onFinishMessage?: (botMessage: ChatMessage) => void;
        onError?: (error: Error, isAborted: boolean) => void;
        /** 前缀补全：sendMessages 最后一条是 assistant 前缀 */
        prefix?: boolean;
      }) {
        const { session, sendMessages, modelConfig, botMessage, flush } =
          options;
        const trackingId = options.trackingId ?? botMessage.id;

        // 同一次请求只处理一次错误：
        // provider 可能先回调 onError，再让 chat() 的 promise 也 reject。
        let errorHandled = false;
        const handleError = (error: Error) => {
          if (errorHandled) return;
          errorHandled = true;

          const isAborted = error?.message?.includes?.("aborted");
          const message = error?.message ?? String(error);

          // 还没吐出任何内容就被用户停止：把这条空占位直接删掉，
          // 不要留一个只有 "aborted" 字样的错误气泡
          if (isAborted && !botMessage.content) {
            botMessage.streaming = false;
            botMessage.isError = false;
            get().updateTargetSession(session, (session) => {
              session.messages = session.messages.filter(
                (m) => m.id !== botMessage.id,
              );
            });
            flush();
            // 交给调用方收尾（比如重新生成时把空候选删掉）
            options.onError?.(error, true);
            ChatControllerPool.remove(session.id, trackingId);
            return;
          }

          botMessage.content +=
            "\n\n" +
            prettyObject({
              error: true,
              message,
            });
          botMessage.streaming = false;
          botMessage.isError = !isAborted;
          options.onError?.(error, !!isAborted);
          flush();
          ChatControllerPool.remove(session.id, trackingId);

          console.error("[Chat] failed ", error);
        };

        try {
          const api: ClientApi = getClientApi(modelConfig.providerName);

          // make request
          const request = api.llm.chat({
            messages: sendMessages,
            config: { ...modelConfig, stream: true },
            prefix: options.prefix,
            onUpdate(message) {
              botMessage.streaming = true;
              if (message) {
                botMessage.content = message;
              }
              flush();
            },
            onFinish(message) {
              botMessage.streaming = false;
              if (message) {
                botMessage.content = message;
                botMessage.date = new Date().toLocaleString();
                options.onFinishMessage?.(botMessage);
              }
              flush();
              ChatControllerPool.remove(session.id, trackingId);
            },
            onBeforeTool(tool: ChatMessageTool) {
              (botMessage.tools = botMessage?.tools || []).push(tool);
              flush();
            },
            onAfterTool(tool: ChatMessageTool) {
              botMessage?.tools?.forEach((t, i, tools) => {
                if (tool.id == t.id) {
                  tools[i] = { ...tool };
                }
              });
              flush();
            },
            onError(error) {
              handleError(error);
            },
            onController(controller) {
              // collect controller for stop/retry
              ChatControllerPool.addController(
                session.id,
                trackingId,
                controller,
              );
            },
          });

          // 部分 provider 的 chat() 是 async：内部异常会变成 rejected promise，
          // 不接住就是 unhandled rejection（低配环境里可能直接把页面带崩）。
          Promise.resolve(request).catch(handleError);
        } catch (error) {
          // provider 初始化 / 参数校验等同步异常，同样落到错误气泡里
          handleError(error as Error);
        }
      },

      /**
       * 切换某条消息当前显示的候选回复。
       * 切换前会先把消息当前内容写回快照，因此手动编辑过的内容不会丢。
       */
      selectMessageVariant(
        targetSession: ChatSession,
        messageId: string,
        index: number,
      ) {
        get().updateTargetSession(targetSession, (session) => {
          const message = session.messages.find((m) => m.id === messageId);
          if (!message) return;
          switchMessageVariant(message, index);
        });
      },

      /**
       * 为某条 assistant 消息生成一个新的候选回复。
       * 旧的回复会作为候选保留下来，不会被删除。
       */
      async regenerateMessage(targetSession: ChatSession, messageId: string) {
        const session = targetSession;
        const messageIndex = session.messages.findIndex(
          (m) => m.id === messageId,
        );
        if (messageIndex < 0) return;

        const target = session.messages[messageIndex];
        if (target.role !== "assistant" || target.streaming) return;

        // 重新生成必须能对应到一条 user 消息
        const userMessage = session.messages[messageIndex - 1];
        if (!userMessage || userMessage.role !== "user") {
          console.error("[Chat] failed to regenerate message", target);
          return;
        }

        const modelConfig = session.mask.modelConfig;

        // 第一次生成候选时，原来的回复会被保存成第 1 个候选
        const botMessage = createMessage({
          role: "assistant",
          streaming: true,
          model: modelConfig.model,
        });
        const newIndex = addMessageVariant(target, snapshotMessage(botMessage));

        // 先同步切到“生成中”：界面立刻清空旧内容、显示正在输入，
        // 同时也能挡住重复点击（否则连点几次会叠出好几条回复）。
        target.streaming = true;
        target.isError = false;
        target.tools = undefined;
        target.audio_url = undefined;
        session.lastUpdate = Date.now();

        // 把 botMessage 的流式内容同步到消息本体和候选快照
        const flush = () => {
          get().updateTargetSession(session, (session) => {
            const message = session.messages.find((m) => m.id === target.id);
            if (!message) return;

            const variant = message.variants?.[newIndex];
            if (variant) {
              variant.content = botMessage.content;
              variant.model = botMessage.model;
              variant.date = botMessage.date;
              variant.tools = botMessage.tools;
              variant.isError = botMessage.isError;
              variant.audio_url = botMessage.audio_url;
            }

            message.content = botMessage.content;
            message.model = botMessage.model;
            message.date = botMessage.date;
            message.tools = botMessage.tools;
            message.isError = botMessage.isError;
            message.streaming = botMessage.streaming;

            session.messages = session.messages.concat();
          });
        };

        // 立刻刷新一次，显示“正在输入”（不等下面的历史拼装）
        flush();

        // 准备阶段就被停止：把刚加的空候选删掉，切回原来的回复
        const dropEmptyVariant = () => {
          get().updateTargetSession(session, (session) => {
            const message = session.messages.find((m) => m.id === target.id);
            if (!message?.variants) return;

            message.variants = message.variants.filter(
              (_, i) => i !== newIndex,
            );
            message.variantIndex = Math.max(
              0,
              Math.min(message.variantIndex ?? 0, message.variants.length - 1),
            );

            const variant = message.variants[message.variantIndex];
            if (variant) applyMessageVariant(message, variant);
            message.streaming = false;
            session.messages = session.messages.concat();
          });
        };

        if (ChatControllerPool.isCancelled(session.id, target.id)) {
          ChatControllerPool.remove(session.id, target.id);
          dropEmptyVariant();
          return;
        }

        try {
          // 只拼接到这条回复之前的历史（包含它对应的 user 消息）。
          // 这一步可能比较慢（MCP 提示词 / 记忆摘要），所以放在刷新之后。
          const sendMessages = await get().getMessagesWithMemory(messageIndex);

          get().chatWithApi({
            session,
            sendMessages,
            modelConfig,
            botMessage,
            trackingId: target.id,
            flush,
            onError: (_error, isAborted) => {
              // 还没生成任何内容就停止：不留空候选
              if (isAborted && !botMessage.content) dropEmptyVariant();
            },
          });
        } catch (e) {
          // 历史构造失败：把状态收回来，别让消息一直卡在“生成中”
          console.error("[Chat] regenerate failed", e);
          botMessage.streaming = false;
          botMessage.isError = true;
          flush();
        }
      },

      /**
       * 继续生成（前缀补全）。
       *
       * 把这条 assistant 消息的现有内容当作“前缀”发回给模型，让它接着往下写，
       * 新增的部分直接追加到原消息后面。适合生成到一半被刷新/中断的情况。
       * 只有标记为「未完成」（isComplete === false）的消息才能用。
       */
      async continueMessage(targetSession: ChatSession, messageId: string) {
        const session = targetSession;
        const messageIndex = session.messages.findIndex(
          (m) => m.id === messageId,
        );
        if (messageIndex < 0) return;

        const target = session.messages[messageIndex];
        if (target.role !== "assistant" || target.streaming) return;
        if (target.isComplete !== false) return;

        const modelConfig = session.mask.modelConfig;
        const api = getClientApi(modelConfig.providerName);
        if (!api.llm.supportsPrefixCompletion) {
          console.warn(
            "[Chat] provider does not support prefix completion",
            modelConfig.providerName,
          );
          return;
        }

        // 已经写出来的内容就是前缀，必须原样（不做任何过滤）送回去
        const prefix = getMessageTextContent(target);

        // botMessage 只装“续写出来的部分”
        const botMessage = createMessage({
          role: "assistant",
          streaming: true,
          model: modelConfig.model,
        });

        const flush = () => {
          get().updateTargetSession(session, (session) => {
            const message = session.messages.find((m) => m.id === target.id);
            if (!message) return;

            message.content = prefix + botMessage.content;
            message.streaming = botMessage.streaming;
            message.model = botMessage.model;
            message.isError = botMessage.isError;

            session.messages = session.messages.concat();
          });
        };

        // 先把状态切到“生成中”：按钮立刻变成停止，也挡住重复点击
        target.streaming = true;
        flush();

        let sendMessages: RequestMessage[];
        try {
          sendMessages = await get().getMessagesWithMemory(messageIndex + 1);
        } catch (e) {
          console.error("[Chat] continue failed", e);
          botMessage.streaming = false;
          botMessage.isError = true;
          flush();
          return;
        }

        if (sendMessages.length === 0) {
          botMessage.streaming = false;
          flush();
          return;
        }

        // 最后一条必须是这条 assistant 前缀
        const last = sendMessages[sendMessages.length - 1] as ChatMessage;
        last.role = "assistant";
        last.content = prefix;

        get().chatWithApi({
          session,
          sendMessages,
          modelConfig,
          botMessage,
          trackingId: target.id,
          prefix: true,
          flush,
          // 续写成功就标记为已完成；用户仍可在编辑里重新取消勾选
          onFinishMessage: () => {
            get().updateTargetSession(session, (session) => {
              const message = session.messages.find((m) => m.id === target.id);
              if (!message) return;
              message.isComplete = true;
              session.messages = session.messages.concat();
            });
          },
        });
      },

      getMemoryPrompt() {
        const session = get().currentSession();

        if (session.memoryPrompt.length) {
          return {
            role: "system",
            content: Locale.Store.Prompt.History(session.memoryPrompt),
            date: "",
          } as ChatMessage;
        }
      },

      /**
       * @param endIndex 只取 session.messages 中该下标之前的消息
       *   （重新生成某条候选回复时用，避免把后面的对话也发出去）
       */
      async getMessagesWithMemory(endIndex?: number) {
        const session = get().currentSession();
        const modelConfig = session.mask.modelConfig;
        const clearContextIndex = session.clearContextIndex ?? 0;
        const messages =
          endIndex === undefined
            ? session.messages.slice()
            : session.messages.slice(0, Math.max(0, endIndex));
        const totalMessageCount = messages.length;

        // in-context prompts
        const contextPrompts = session.mask.context.slice();

        // system prompts, to get close to OpenAI Web ChatGPT
        const shouldInjectSystemPrompts =
          modelConfig.enableInjectSystemPrompts &&
          (session.mask.modelConfig.model.startsWith("gpt-") ||
            session.mask.modelConfig.model.startsWith("chatgpt-"));

        // MCP 提示词是通过 Next server action 拿的：
        // 低配/弱网环境下可能失败、超时，静态导出（export/app）环境下甚至根本不可用。
        // 失败时降级为「不带 MCP 提示词」，绝不能让整条发送链路跟着失败。
        let mcpEnabled = false;
        let mcpSystemPrompt = "";
        try {
          mcpEnabled = await isMcpEnabled();
          mcpSystemPrompt = mcpEnabled ? await getMcpSystemPrompt() : "";
        } catch (error) {
          console.warn("[MCP] failed to build system prompt, skip it", error);
          mcpEnabled = false;
          mcpSystemPrompt = "";
        }

        var systemPrompts: ChatMessage[] = [];

        if (shouldInjectSystemPrompts) {
          systemPrompts = [
            createMessage({
              role: "system",
              content:
                fillTemplateWith("", {
                  ...modelConfig,
                  template: DEFAULT_SYSTEM_TEMPLATE,
                }) + mcpSystemPrompt,
            }),
          ];
        } else if (mcpEnabled) {
          systemPrompts = [
            createMessage({
              role: "system",
              content: mcpSystemPrompt,
            }),
          ];
        }

        if (shouldInjectSystemPrompts || mcpEnabled) {
          console.log(
            "[Global System Prompt] ",
            systemPrompts.at(0)?.content ?? "empty",
          );
        }
        const memoryPrompt = get().getMemoryPrompt();
        // long term memory
        const shouldSendLongTermMemory =
          modelConfig.sendMemory &&
          session.memoryPrompt &&
          session.memoryPrompt.length > 0 &&
          session.lastSummarizeIndex > clearContextIndex;
        const longTermMemoryPrompts =
          shouldSendLongTermMemory && memoryPrompt ? [memoryPrompt] : [];
        const longTermMemoryStartIndex = session.lastSummarizeIndex;

        // short term memory
        const shortTermMemoryStartIndex = Math.max(
          0,
          totalMessageCount - modelConfig.historyMessageCount,
        );

        // lets concat send messages, including 4 parts:
        // 0. system prompt: to get close to OpenAI Web ChatGPT
        // 1. long term memory: summarized memory messages
        // 2. pre-defined in-context prompts
        // 3. short term memory: latest n messages
        // 4. newest input message
        const memoryStartIndex = shouldSendLongTermMemory
          ? Math.min(longTermMemoryStartIndex, shortTermMemoryStartIndex)
          : shortTermMemoryStartIndex;
        // and if user has cleared history messages, we should exclude the memory too.
        const contextStartIndex = Math.max(clearContextIndex, memoryStartIndex);
        const maxTokenThreshold = modelConfig.max_tokens;

        // get recent messages as much as possible
        const reversedRecentMessages = [];
        for (
          let i = totalMessageCount - 1, tokenCount = 0;
          i >= contextStartIndex && tokenCount < maxTokenThreshold;
          i -= 1
        ) {
          const msg = messages[i];
          if (!msg || msg.isError) continue;
          tokenCount += estimateTokenLength(getMessageTextContent(msg));
          reversedRecentMessages.push(msg);
        }
        // concat all messages
        const recentMessages = [
          ...systemPrompts,
          ...longTermMemoryPrompts,
          ...contextPrompts,
          ...reversedRecentMessages.reverse(),
        ];

        return recentMessages;
      },

      updateMessage(
        sessionIndex: number,
        messageIndex: number,
        updater: (message?: ChatMessage) => void,
      ) {
        const sessions = get().sessions;
        const session = sessions.at(sessionIndex);
        const messages = session?.messages;
        updater(messages?.at(messageIndex));
        set(() => ({ sessions }));
      },

      resetSession(session: ChatSession) {
        get().updateTargetSession(session, (session) => {
          session.messages = [];
          session.memoryPrompt = "";
        });
      },

      summarizeSession(
        refreshTitle: boolean = false,
        targetSession: ChatSession,
      ) {
        const config = useAppConfig.getState();
        const session = targetSession;
        const modelConfig = session.mask.modelConfig;
        // skip summarize when using dalle3?
        if (isDalle3(modelConfig.model)) {
          return;
        }

        // if not config compressModel, then using getSummarizeModel
        const [model, providerName] = modelConfig.compressModel
          ? [modelConfig.compressModel, modelConfig.compressProviderName]
          : getSummarizeModel(
              session.mask.modelConfig.model,
              session.mask.modelConfig.providerName,
            );
        const api: ClientApi = getClientApi(providerName as ServiceProvider);

        // remove error messages if any
        const messages = session.messages;

        // should summarize topic after chating more than 50 words
        const SUMMARIZE_MIN_LEN = 50;
        if (
          (config.enableAutoGenerateTitle &&
            session.topic === DEFAULT_TOPIC &&
            countMessages(messages) >= SUMMARIZE_MIN_LEN) ||
          refreshTitle
        ) {
          const startIndex = Math.max(
            0,
            messages.length - modelConfig.historyMessageCount,
          );
          const topicMessages = messages
            .slice(
              startIndex < messages.length ? startIndex : messages.length - 1,
              messages.length,
            )
            .concat(
              createMessage({
                role: "user",
                content: Locale.Store.Prompt.Topic,
              }),
            );
          api.llm.chat({
            messages: topicMessages,
            config: {
              model,
              stream: false,
              providerName,
            },
            onFinish(message, responseRes) {
              if (responseRes?.status === 200) {
                get().updateTargetSession(
                  session,
                  (session) =>
                    (session.topic =
                      message.length > 0 ? trimTopic(message) : DEFAULT_TOPIC),
                );
              }
            },
          });
        }
        const summarizeIndex = Math.max(
          session.lastSummarizeIndex,
          session.clearContextIndex ?? 0,
        );
        let toBeSummarizedMsgs = messages
          .filter((msg) => !msg.isError)
          .slice(summarizeIndex);

        const historyMsgLength = countMessages(toBeSummarizedMsgs);

        if (historyMsgLength > (modelConfig?.max_tokens || 4000)) {
          const n = toBeSummarizedMsgs.length;
          toBeSummarizedMsgs = toBeSummarizedMsgs.slice(
            Math.max(0, n - modelConfig.historyMessageCount),
          );
        }
        const memoryPrompt = get().getMemoryPrompt();
        if (memoryPrompt) {
          // add memory prompt
          toBeSummarizedMsgs.unshift(memoryPrompt);
        }

        const lastSummarizeIndex = session.messages.length;

        console.log(
          "[Chat History] ",
          toBeSummarizedMsgs,
          historyMsgLength,
          modelConfig.compressMessageLengthThreshold,
        );

        if (
          historyMsgLength > modelConfig.compressMessageLengthThreshold &&
          modelConfig.sendMemory
        ) {
          /** Destruct max_tokens while summarizing
           * this param is just shit
           **/
          const { max_tokens, ...modelcfg } = modelConfig;
          api.llm.chat({
            messages: toBeSummarizedMsgs.concat(
              createMessage({
                role: "system",
                content: Locale.Store.Prompt.Summarize,
                date: "",
              }),
            ),
            config: {
              ...modelcfg,
              stream: true,
              model,
              providerName,
            },
            onUpdate(message) {
              session.memoryPrompt = message;
            },
            onFinish(message, responseRes) {
              if (responseRes?.status === 200) {
                console.log("[Memory] ", message);
                get().updateTargetSession(session, (session) => {
                  session.lastSummarizeIndex = lastSummarizeIndex;
                  session.memoryPrompt = message; // Update the memory prompt for stored it in local storage
                });
              }
            },
            onError(err) {
              console.error("[Summarize] ", err);
            },
          });
        }
      },

      updateStat(message: ChatMessage, session: ChatSession) {
        get().updateTargetSession(session, (session) => {
          session.stat.charCount += message.content.length;
          // TODO: should update chat count and word count
        });
      },
      updateTargetSession(
        targetSession: ChatSession,
        updater: (session: ChatSession) => void,
      ) {
        const sessions = get().sessions;
        const index = sessions.findIndex((s) => s.id === targetSession.id);
        if (index < 0) return;
        updater(sessions[index]);
        set(() => ({ sessions }));
      },

      /**
       * 上次生成到一半就刷新 / 关掉页面，消息会停在 streaming 状态。
       * 启动时把这些消息标成「未完成」，消息上就会出现「继续生成」按钮，
       * 用前缀补全把剩下的一半补上。
       */
      repairInterruptedMessages() {
        const sessions = get().sessions;
        let changed = false;

        for (const session of sessions) {
          for (const message of session.messages) {
            if (message.streaming) {
              message.streaming = false;
              message.isComplete = false;
              changed = true;
            }
          }
        }

        if (changed) {
          console.log("[Chat] marked interrupted messages as incomplete");
          set(() => ({ sessions: sessions.concat() }));
        }
      },

      /**
       * 修复本地会话数据（不删任何对话内容和标题）。
       *
       * 只清理“重复数据”：
       * - 会话 id 重复 → 重新生成一个（重复 id 会让云端两个会话互相覆盖）；
       * - 候选回复里完全相同的条目去重；
       * - 只有一个候选且和正文完全一致时，把这个冗余副本删掉
       *   （正是它让会话 JSON 体积翻倍、云端分块数也翻倍）。
       *
       * 清理后建议再做一次「全量上传」，让云端重新分块 / 计算哈希。
       */
      repairLocalSessions() {
        const sessions = get().sessions;
        const usedIds = new Set<string>();
        let duplicateIds = 0;
        let duplicateVariants = 0;
        let totalMessages = 0;

        const sameContent = (a: any, b: any) => {
          if (a === b) return true;
          try {
            return JSON.stringify(a) === JSON.stringify(b);
          } catch {
            return false;
          }
        };

        const repaired = sessions.map((session) => {
          let id = session.id;
          if (!id || usedIds.has(id)) {
            id = nanoid();
            duplicateIds += 1;
          }
          usedIds.add(id);

          const messages = (
            Array.isArray(session.messages) ? session.messages : []
          ).map((raw) => {
            const message = raw as ChatMessage;
            if (!message.id) message.id = nanoid();

            if (Array.isArray(message.variants) && message.variants.length) {
              const seen = new Set<string>();
              const unique = message.variants.filter((variant) => {
                const key = `${JSON.stringify(variant.content)}|${
                  variant.model
                }|${variant.date}|${variant.isError}`;
                if (seen.has(key)) {
                  duplicateVariants += 1;
                  return false;
                }
                seen.add(key);
                return true;
              });

              const onlyOne =
                unique.length === 1 &&
                sameContent(unique[0].content, message.content) &&
                unique[0].model === message.model;

              if (onlyOne) {
                // 正文和唯一候选一模一样：纯冗余，直接去掉
                duplicateVariants += 1;
                delete message.variants;
                delete message.variantIndex;
              } else {
                message.variants = unique;
                message.variantIndex = Math.min(
                  Math.max(message.variantIndex ?? 0, 0),
                  unique.length - 1,
                );
              }
            }

            totalMessages += 1;
            return message;
          });

          return { ...session, id, messages };
        });

        set(() => ({ sessions: repaired }));

        const report = {
          sessions: repaired.length,
          messages: totalMessages,
          duplicateIds,
          duplicateVariants,
        };
        console.log("[Chat] repaired local sessions", report);
        return report;
      },

      async clearAllData() {
        await indexedDBStorage.clear();
        localStorage.clear();
        location.reload();
      },
      setLastInput(lastInput: string) {
        set({
          lastInput,
        });
      },

      /** check if the message contains MCP JSON and execute the MCP action */
      checkMcpJson(message: ChatMessage) {
        const mcpEnabled = isMcpEnabled();
        if (!mcpEnabled) return;
        const content = getMessageTextContent(message);
        if (isMcpJson(content)) {
          try {
            const mcpRequest = extractMcpJson(content);
            if (mcpRequest) {
              console.debug("[MCP Request]", mcpRequest);

              executeMcpAction(mcpRequest.clientId, mcpRequest.mcp)
                .then((result) => {
                  console.log("[MCP Response]", result);
                  const mcpResponse =
                    typeof result === "object"
                      ? JSON.stringify(result)
                      : String(result);
                  get().onUserInput(
                    `\`\`\`json:mcp-response:${mcpRequest.clientId}\n${mcpResponse}\n\`\`\``,
                    [],
                    true,
                  );
                })
                .catch((error) => showToast("MCP execution failed", error));
            }
          } catch (error) {
            console.error("[Check MCP JSON]", error);
          }
        }
      },
    };

    return methods;
  },
  {
    name: StoreKey.Chat,
    version: 3.3,
    migrate(persistedState, version) {
      const state = persistedState as any;
      const newState = JSON.parse(
        JSON.stringify(state),
      ) as typeof DEFAULT_CHAT_STATE;

      if (version < 2) {
        newState.sessions = [];

        const oldSessions = state.sessions;
        for (const oldSession of oldSessions) {
          const newSession = createEmptySession();
          newSession.topic = oldSession.topic;
          newSession.messages = [...oldSession.messages];
          newSession.mask.modelConfig.sendMemory = true;
          newSession.mask.modelConfig.historyMessageCount = 4;
          newSession.mask.modelConfig.compressMessageLengthThreshold = 1000;
          newState.sessions.push(newSession);
        }
      }

      if (version < 3) {
        // migrate id to nanoid
        newState.sessions.forEach((s) => {
          s.id = nanoid();
          s.messages.forEach((m) => (m.id = nanoid()));
        });
      }

      // Enable `enableInjectSystemPrompts` attribute for old sessions.
      // Resolve issue of old sessions not automatically enabling.
      if (version < 3.1) {
        newState.sessions.forEach((s) => {
          if (
            // Exclude those already set by user
            !s.mask.modelConfig.hasOwnProperty("enableInjectSystemPrompts")
          ) {
            // Because users may have changed this configuration,
            // the user's current configuration is used instead of the default
            const config = useAppConfig.getState();
            s.mask.modelConfig.enableInjectSystemPrompts =
              config.modelConfig.enableInjectSystemPrompts;
          }
        });
      }

      // add default summarize model for every session
      if (version < 3.2) {
        newState.sessions.forEach((s) => {
          const config = useAppConfig.getState();
          s.mask.modelConfig.compressModel = config.modelConfig.compressModel;
          s.mask.modelConfig.compressProviderName =
            config.modelConfig.compressProviderName;
        });
      }
      // revert default summarize model for every session
      if (version < 3.3) {
        newState.sessions.forEach((s) => {
          const config = useAppConfig.getState();
          s.mask.modelConfig.compressModel = "";
          s.mask.modelConfig.compressProviderName = "";
        });
      }

      return newState as any;
    },
  },
);
