import { useDebouncedCallback } from "use-debounce";
import React, {
  Fragment,
  RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import SendWhiteIcon from "../icons/send-white.svg";
import RenameIcon from "../icons/rename.svg";
import EditIcon from "../icons/rename.svg";
import ExportIcon from "../icons/share.svg";
import UploadIcon from "../icons/upload.svg";
import ReturnIcon from "../icons/return.svg";
import CopyIcon from "../icons/copy.svg";
import SpeakIcon from "../icons/speak.svg";
import SpeakStopIcon from "../icons/speak-stop.svg";
import LoadingIcon from "../icons/three-dots.svg";
import LoadingButtonIcon from "../icons/loading.svg";
import PromptIcon from "../icons/prompt.svg";
import MaskIcon from "../icons/mask.svg";
import MaxIcon from "../icons/max.svg";
import MinIcon from "../icons/min.svg";
import ResetIcon from "../icons/reload.svg";
import ReloadIcon from "../icons/reload.svg";
import PlayIcon from "../icons/play.svg";
import SettingsIcon from "../icons/chat-settings.svg";
import DeleteIcon from "../icons/clear.svg";
import ConfirmIcon from "../icons/confirm.svg";
import CloseIcon from "../icons/close.svg";
import CancelIcon from "../icons/cancel.svg";
import ImageIcon from "../icons/image.svg";
import EyeIcon from "../icons/eye.svg";

import LightIcon from "../icons/light.svg";
import DarkIcon from "../icons/dark.svg";
import AutoIcon from "../icons/auto.svg";
import BottomIcon from "../icons/bottom.svg";
import StopIcon from "../icons/pause.svg";
import RobotIcon from "../icons/robot.svg";
import SizeIcon from "../icons/size.svg";
import QualityIcon from "../icons/hd.svg";
import StyleIcon from "../icons/palette.svg";
import PluginIcon from "../icons/plugin.svg";
import ShortcutkeyIcon from "../icons/shortcutkey.svg";
import McpToolIcon from "../icons/tool.svg";
import HeadphoneIcon from "../icons/headphone.svg";
import {
  BOT_HELLO,
  ChatMessage,
  ChatSession,
  createMessage,
  DEFAULT_TOPIC,
  getMessageVariantCount,
  getMessageVariantIndex,
  ModelType,
  SubmitKey,
  Theme,
  useAccessStore,
  useAppConfig,
  useChatStore,
  usePluginStore,
} from "../store";
import { useLowMemoryStore } from "../store/low-memory";
import { useSyncStore } from "../store/sync";
import { useKnowledgeStore } from "../store/knowledge";
import { PINNED_BUDGET_TOKENS } from "../utils/knowledge/retrieval";
import { filterValidSectionIds } from "../utils/knowledge/affected";
import { showKnowledgePreview } from "./knowledge-preview";
import { showKnowledgeSectionPicker } from "./knowledge-picker";
import { KnowledgeBadge } from "./knowledge-badge";
import { uploadSessionNow } from "../utils/upload-one";
// 误删兜底暂时关闭（见 _Chat 里的说明）。需要时再放开：
// import { attachInputDiagnostics } from "../utils/input-diag";
import { getPortalHost } from "../utils/portal";
import { shouldRestoreLostInput } from "../utils/input-recovery";
import {
  ACCEPT_FILE,
  MAX_ATTACHMENTS,
  deleteFile,
  getMaxSizeMB,
  getUploadPurpose,
  isImageFile,
  toChatAttachment,
  uploadFile,
} from "../utils/attachments";
import { hasPendingAttachments } from "../utils/attachment-rules";
import { AttachmentChips, MessageAttachments } from "./attachments";
import type { ChatAttachment } from "../store/chat";

import {
  autoGrowTextArea,
  copyToClipboard,
  getMessageImages,
  getMessageTextContent,
  isDalle3,
  isVisionModel,
  safeLocalStorage,
  getModelSizes,
  supportsCustomSize,
  useMobileScreen,
  selectOrCopy,
  showPlugins,
} from "../utils";

import { uploadImage as uploadImageRemote } from "@/app/utils/chat";
import {
  canLoadEarlier,
  canPinStreamingScroll,
  clampRenderIndex,
  getChatScrollState,
  getStreamingPinTarget,
  isScrollContentShort,
  prevPageIndex,
  shouldPinDuringStreaming,
} from "@/app/utils/chat-scroll";

import dynamic from "next/dynamic";

import { ChatControllerPool } from "../client/controller";
import { DalleQuality, DalleStyle, ModelSize } from "../typing";
import { Prompt, usePromptStore } from "../store/prompt";
import Locale from "../locales";

import { IconButton } from "./button";
import styles from "./chat.module.scss";

import {
  List,
  ListItem,
  Modal,
  Selector,
  showConfirm,
  showPrompt,
  showToast,
} from "./ui-lib";
import { useNavigate } from "react-router-dom";
import {
  CHAT_PAGE_SIZE,
  DEFAULT_TTS_ENGINE,
  ModelProvider,
  Path,
  REQUEST_TIMEOUT_MS,
  ServiceProvider,
  UNFINISHED_INPUT,
} from "../constant";
import { Avatar } from "./emoji";
import { ContextPrompts, MaskAvatar, MaskConfig } from "./mask";
import { useMaskStore } from "../store/mask";
import { ChatCommandPrefix, useChatCommand, useCommand } from "../command";
import { prettyObject } from "../utils/format";
import { ExportMessageModal } from "./exporter";
import { MessageDebugModal } from "./message-debug";
import { getClientConfig } from "../config/client";
import { useAllModels } from "../utils/hooks";
import { ClientApi, MultimodalContent, getClientApi } from "../client/api";
import { createTTSPlayer } from "../utils/audio";
import { MsEdgeTTS, OUTPUT_FORMAT } from "../utils/ms_edge_tts";

import { isEmpty } from "lodash-es";
import { getModelProvider } from "../utils/model";
import { shouldShowMessageActions } from "../utils/message-actions";
import { RealtimeChat } from "@/app/components/realtime-chat";
import clsx from "clsx";
import { getAvailableClientsCount, isMcpEnabled } from "../mcp/actions";

/**
 * 输入框最多显示的行数。
 * 手机上输入很多换行时，输入框会一路长高，把发送按钮顶出屏幕；
 * 超过这个行数后只在框内滚动。
 */
const MAX_INPUT_ROWS = 6;

const localStorage = safeLocalStorage();

const ttsPlayer = createTTSPlayer();

const Markdown = dynamic(async () => (await import("./markdown")).Markdown, {
  loading: () => <LoadingIcon />,
});

const MCPAction = () => {
  const navigate = useNavigate();
  const [count, setCount] = useState<number>(0);
  const [mcpEnabled, setMcpEnabled] = useState(false);

  useEffect(() => {
    const checkMcpStatus = async () => {
      const enabled = await isMcpEnabled();
      setMcpEnabled(enabled);
      if (enabled) {
        const count = await getAvailableClientsCount();
        setCount(count);
      }
    };
    checkMcpStatus();
  }, []);

  if (!mcpEnabled) return null;

  return (
    <ChatAction
      onClick={() => navigate(Path.McpMarket)}
      text={`MCP${count ? ` (${count})` : ""}`}
      icon={<McpToolIcon />}
    />
  );
};

export function SessionConfigModel(props: { onClose: () => void }) {
  const chatStore = useChatStore();
  const session = chatStore.currentSession();
  const maskStore = useMaskStore();
  const navigate = useNavigate();

  return (
    <div className="modal-mask">
      <Modal
        title={Locale.Context.Edit}
        onClose={() => props.onClose()}
        actions={[
          <IconButton
            key="reset"
            icon={<ResetIcon />}
            bordered
            text={Locale.Chat.Config.Reset}
            onClick={async () => {
              if (await showConfirm(Locale.Memory.ResetConfirm)) {
                chatStore.updateTargetSession(
                  session,
                  (session) => (session.memoryPrompt = ""),
                );
              }
            }}
          />,
          <IconButton
            key="copy"
            icon={<CopyIcon />}
            bordered
            text={Locale.Chat.Config.SaveAs}
            onClick={() => {
              navigate(Path.Masks);
              setTimeout(() => {
                maskStore.create(session.mask);
              }, 500);
            }}
          />,
        ]}
      >
        <MaskConfig
          mask={session.mask}
          updateMask={(updater) => {
            const mask = { ...session.mask };
            updater(mask);
            chatStore.updateTargetSession(
              session,
              (session) => (session.mask = mask),
            );
          }}
          shouldSyncFromGlobal
          extraListItems={
            <>
              {session.mask.modelConfig.sendMemory ? (
                <ListItem
                  className="copyable"
                  title={`${Locale.Memory.Title} (${session.lastSummarizeIndex} of ${session.messages.length})`}
                  subTitle={session.memoryPrompt || Locale.Memory.EmptyContent}
                ></ListItem>
              ) : null}

              {/* 会话级知识库开关：默认关闭；开启后才会在发送时检索 */}
              <ListItem
                title={Locale.Chat.Knowledge.Enable}
                subTitle={Locale.Chat.Knowledge.EnableSubTitle}
              >
                <input
                  type="checkbox"
                  aria-label={Locale.Chat.Knowledge.Enable}
                  checked={!!session.knowledge?.enabled}
                  onChange={(e) => {
                    const enabled = e.currentTarget.checked;
                    chatStore.updateTargetSession(session, (session) => {
                      session.knowledge = {
                        ...session.knowledge,
                        enabled,
                      };
                    });
                    if (enabled) void useKnowledgeStore.getState().refresh();
                  }}
                />
              </ListItem>

              {session.knowledge?.enabled && (
                <ListItem
                  title={Locale.Chat.Knowledge.DebugPreview}
                  subTitle={Locale.Chat.Knowledge.DebugPreviewSubTitle}
                >
                  <input
                    type="checkbox"
                    aria-label={Locale.Chat.Knowledge.DebugPreview}
                    checked={!!session.knowledge?.debugPreview}
                    onChange={(e) => {
                      const debugPreview = e.currentTarget.checked;
                      chatStore.updateTargetSession(session, (session) => {
                        session.knowledge = {
                          ...session.knowledge,
                          debugPreview,
                        };
                      });
                    }}
                  />
                </ListItem>
              )}

              {/* 手动挑片段：文档标题常是「概述」这种泛化词，自动检索选不准时点名 */}
              {session.knowledge?.enabled && (
                <ListItem
                  title={Locale.Chat.Knowledge.PinnedButton}
                  subTitle={
                    session.knowledge?.sectionIds?.length
                      ? Locale.Chat.Knowledge.PinnedCount(
                          session.knowledge.sectionIds.length,
                        )
                      : Locale.Chat.Knowledge.PinnedNone
                  }
                >
                  <IconButton
                    text={Locale.Chat.Knowledge.PinnedButton}
                    onClick={async () => {
                      const sections = await useKnowledgeStore
                        .getState()
                        .listSections();
                      const picked = await showKnowledgeSectionPicker({
                        sections,
                        selected: session.knowledge?.sectionIds ?? [],
                      });
                      if (picked === null) return;
                      chatStore.updateTargetSession(session, (session) => {
                        session.knowledge = {
                          ...session.knowledge,
                          sectionIds: picked,
                        };
                      });
                    }}
                  />
                </ListItem>
              )}
            </>
          }
        ></MaskConfig>
      </Modal>
    </div>
  );
}

function PromptToast(props: {
  showModal?: boolean;
  setShowModal: (_: boolean) => void;
}) {
  return (
    <div className={styles["prompt-toast"]} key="prompt-toast">
      {/* 「包含 N 条预设提示词」的提示条已去掉：滚上去时会打断阅读 */}
      {props.showModal && (
        <SessionConfigModel onClose={() => props.setShowModal(false)} />
      )}
    </div>
  );
}

function useSubmitHandler() {
  const config = useAppConfig();
  const submitKey = config.submitKey;
  const isComposing = useRef(false);

  useEffect(() => {
    const onCompositionStart = () => {
      isComposing.current = true;
    };
    const onCompositionEnd = () => {
      isComposing.current = false;
    };

    window.addEventListener("compositionstart", onCompositionStart);
    window.addEventListener("compositionend", onCompositionEnd);

    return () => {
      window.removeEventListener("compositionstart", onCompositionStart);
      window.removeEventListener("compositionend", onCompositionEnd);
    };
  }, []);

  const shouldSubmit = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Fix Chinese input method "Enter" on Safari
    if (e.keyCode == 229) return false;
    if (e.key !== "Enter") return false;
    if (e.key === "Enter" && (e.nativeEvent.isComposing || isComposing.current))
      return false;
    return (
      (config.submitKey === SubmitKey.AltEnter && e.altKey) ||
      (config.submitKey === SubmitKey.CtrlEnter && e.ctrlKey) ||
      (config.submitKey === SubmitKey.ShiftEnter && e.shiftKey) ||
      (config.submitKey === SubmitKey.MetaEnter && e.metaKey) ||
      (config.submitKey === SubmitKey.Enter &&
        !e.altKey &&
        !e.ctrlKey &&
        !e.shiftKey &&
        !e.metaKey)
    );
  };

  return {
    submitKey,
    shouldSubmit,
  };
}

export type RenderPrompt = Pick<Prompt, "title" | "content">;

export function PromptHints(props: {
  prompts: RenderPrompt[];
  onPromptSelect: (prompt: RenderPrompt) => void;
}) {
  const noPrompts = props.prompts.length === 0;
  const [selectIndex, setSelectIndex] = useState(0);
  const selectedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSelectIndex(0);
  }, [props.prompts.length]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (noPrompts || e.metaKey || e.altKey || e.ctrlKey) {
        return;
      }
      // arrow up / down to select prompt
      const changeIndex = (delta: number) => {
        e.stopPropagation();
        e.preventDefault();
        const nextIndex = Math.max(
          0,
          Math.min(props.prompts.length - 1, selectIndex + delta),
        );
        setSelectIndex(nextIndex);
        selectedRef.current?.scrollIntoView({
          block: "center",
        });
      };

      if (e.key === "ArrowUp") {
        changeIndex(1);
      } else if (e.key === "ArrowDown") {
        changeIndex(-1);
      } else if (e.key === "Enter") {
        const selectedPrompt = props.prompts.at(selectIndex);
        if (selectedPrompt) {
          props.onPromptSelect(selectedPrompt);
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);

    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.prompts.length, selectIndex]);

  if (noPrompts) return null;
  return (
    <div className={styles["prompt-hints"]}>
      {props.prompts.map((prompt, i) => (
        <div
          ref={i === selectIndex ? selectedRef : null}
          className={clsx(styles["prompt-hint"], {
            [styles["prompt-hint-selected"]]: i === selectIndex,
          })}
          key={prompt.title + i.toString()}
          onClick={() => props.onPromptSelect(prompt)}
          onMouseEnter={() => setSelectIndex(i)}
        >
          <div className={styles["hint-title"]}>{prompt.title}</div>
          <div className={styles["hint-content"]}>{prompt.content}</div>
        </div>
      ))}
    </div>
  );
}

function ClearContextDivider() {
  const chatStore = useChatStore();
  const session = chatStore.currentSession();

  return (
    <div
      className={styles["clear-context"]}
      onClick={() =>
        chatStore.updateTargetSession(
          session,
          (session) => (session.clearContextIndex = undefined),
        )
      }
    >
      <div className={styles["clear-context-tips"]}>{Locale.Context.Clear}</div>
      <div className={styles["clear-context-revert-btn"]}>
        {Locale.Context.Revert}
      </div>
    </div>
  );
}

/**
 * 消息气泡下方的一行：
 * - 有多个候选回复时显示 "< 3/5 >" 切换器，切换后气泡重新渲染；
 * - 顺便提供「重新生成」按钮，不用再滚到气泡上方去点。
 */
export function MessageVariantSwitcher(props: {
  session: ChatSession;
  message: ChatMessage;
  /** 重新生成一个候选回复，不传则不显示按钮 */
  onRegenerate?: () => void;
}) {
  const chatStore = useChatStore();
  const count = getMessageVariantCount(props.message);
  const index = getMessageVariantIndex(props.message);

  // 只有一条回复时不需要切换器
  const canSwitch = count > 1;
  const canRegenerate = !!props.onRegenerate;

  if (!canSwitch && !canRegenerate) return null;

  const select = (next: number) => {
    chatStore.selectMessageVariant(props.session, props.message.id, next);
  };

  return (
    <div className={styles["chat-message-variants"]}>
      {canSwitch && (
        <div className={styles["chat-message-variant-switcher"]}>
          <button
            type="button"
            className={styles["chat-message-variant-switch"]}
            title={Locale.Chat.Actions.VariantPrev}
            aria-label={Locale.Chat.Actions.VariantPrev}
            onClick={() => select((index - 1 + count) % count)}
          >
            {"<"}
          </button>
          <span className={styles["chat-message-variant-index"]}>
            {`${index + 1}/${count}`}
          </span>
          <button
            type="button"
            className={styles["chat-message-variant-switch"]}
            title={Locale.Chat.Actions.VariantNext}
            aria-label={Locale.Chat.Actions.VariantNext}
            onClick={() => select((index + 1) % count)}
          >
            {">"}
          </button>
        </div>
      )}
      {canSwitch && canRegenerate && (
        <span className={styles["chat-message-variant-divider"]} />
      )}
      {canRegenerate && (
        <button
          type="button"
          className={styles["chat-message-variant-regenerate"]}
          title={Locale.Chat.Actions.Regenerate}
          aria-label={Locale.Chat.Actions.Regenerate}
          onClick={() => props.onRegenerate?.()}
        >
          <div className={styles["chat-message-variant-regenerate-icon"]}>
            <ResetIcon />
          </div>
        </button>
      )}
    </div>
  );
}

export function ChatAction(props: {
  text: string;
  icon: JSX.Element;
  onClick: () => void;
}) {
  const iconRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState({
    full: 16,
    icon: 16,
  });

  function updateWidth() {
    if (!iconRef.current || !textRef.current) return;
    const getWidth = (dom: HTMLDivElement) => dom.getBoundingClientRect().width;
    const textWidth = getWidth(textRef.current);
    const iconWidth = getWidth(iconRef.current);
    setWidth({
      full: textWidth + iconWidth,
      icon: iconWidth,
    });
  }

  return (
    <div
      className={clsx(styles["chat-input-action"], "clickable")}
      onClick={() => {
        props.onClick();
        setTimeout(updateWidth, 1);
      }}
      onMouseEnter={updateWidth}
      onTouchStart={updateWidth}
      style={
        {
          "--icon-width": `${width.icon}px`,
          "--full-width": `${width.full}px`,
        } as React.CSSProperties
      }
    >
      <div ref={iconRef} className={styles["icon"]}>
        {props.icon}
      </div>
      <div className={styles["text"]} ref={textRef}>
        {props.text}
      </div>
    </div>
  );
}

function useScrollToBottom(
  scrollRef: RefObject<HTMLDivElement>,
  detach: boolean = false,
  messages: ChatMessage[],
  /**
   * 桌面端：流式输出时把「正在生成的那条消息」顶部钉在画面顶部。
   *
   * 移动端保持原来的“跟到底部”行为（窄屏下气泡很快就超过一屏，
   * 钉顶反而会让人看不到刚生成的内容）。
   */
  pinStreamingTop: boolean = false,
) {
  // for auto-scroll
  const [autoScroll, setAutoScroll] = useState(true);

  /** 用户在流式期间主动点了「回到底部」：不再把他拽回气泡顶部 */
  const manualBottomRef = useRef(false);

  /**
   * 这一轮生成里，用户自己滚动过输入区。
   *
   * 桌面端钉住气泡顶部时，每次渲染都会把 scrollTop 拉回「气泡顶部」。
   * 用户想往下看看新生成的内容时，这个拉力会把他拽回去 —— 表现就是
   * 「生成期间往下滚会抽搐、卡在原地，生成完才正常」。
   * 所以只要用户动过滚动条，这一轮就不再钉；下一轮发送时 resetFollow() 会清掉。
   */
  const userScrolledRef = useRef(false);

  /** 由 onChatBodyScroll 在「确实是用户滚的」时调用 */
  const notifyUserScroll = useCallback(() => {
    userScrolledRef.current = true;
  }, []);
  /**
   * 我们自己滚动到的目标位置。
   *
   * 程序滚动同样会触发 scroll 事件，不加区分的话，“往上翻才停止跟随”会把
   * 自己的滚动误判成用户操作（反过来也会漏判）。
   * 用目标位置比对而不是布尔标记：浏览器可能根本不发这次 scroll 事件
   * （位置没变），布尔标记会一直留着，把**下一次真正的用户滚动**吞掉。
   */
  const programmaticTargetRef = useRef<number | null>(null);

  /** 这次 scroll 事件是不是我们自己滚出来的（是就消费掉） */
  const consumeProgrammaticScroll = useCallback((scrollTop: number) => {
    const target = programmaticTargetRef.current;
    if (target === null) return false;
    if (Math.abs(scrollTop - target) > 2) return false;
    programmaticTargetRef.current = null;
    return true;
  }, []);

  const scrollDomToBottom = useCallback(() => {
    const dom = scrollRef.current;
    if (dom) {
      requestAnimationFrame(() => {
        setAutoScroll(true);
        const target = dom.scrollHeight - dom.clientHeight;
        programmaticTargetRef.current = target;
        dom.scrollTo(0, dom.scrollHeight);
      });
    }
  }, [scrollRef]);

  /** 用户主动回到底部（按钮）：流式期间也不要再自动钉顶部 */
  const scrollToBottomManual = useCallback(() => {
    manualBottomRef.current = true;
    scrollDomToBottom();
  }, [scrollDomToBottom]);

  /**
   * 新的一轮生成开始（发送 / 重新生成）：清掉「用户要求停在底部」，
   * 从干净状态重新钉到气泡顶部。
   *
   * 之前重新生成走的是 scrollToBottom()，会把 manualBottom 置位，
   * 于是整段流式都不钉住——表现就是“偶尔还是会一路往下滚”。
   */
  const resetFollow = useCallback(() => {
    manualBottomRef.current = false;
    programmaticTargetRef.current = null;
    userScrolledRef.current = false;
    scrollDomToBottom();
  }, [scrollDomToBottom]);

  /**
   * 流式输出：把「正在生成的那条气泡」顶部顶到容器顶部。
   *
   * 以前是「没超过一屏就跟着底部走，超过了才停」——PC 屏幕高，回复要涨到
   * 超过一屏才钉住，在那之前看起来就是“一直在往下滚”；手机一屏矮，
   * 很快就超过一屏，所以永远像钉住。现在桌面端一开始就钉住。
   *
   * 每次渲染都调用一次：气泡还没顶到顶时继续往下顶，顶到了就不再做任何事
   * （只往下滚，不会把用户往回拽）。
   */
  /**
   * 当前是否还有消息在流式输出。
   *
   * requestAnimationFrame 是**异步**的：生成刚好在这两帧之间结束时，
   * 回调里再去查 `[data-streaming="1"]` 就已经查不到了。以前这里会掉进
   * “气泡还没渲染出来 → 先贴底”的分支，于是生成结束的一瞬间被拽到最底下，
   * 也就是「什么都不做，却自己滚到最底」那个现象（时有时无，看时序）。
   */
  const streamingRef = useRef(false);
  streamingRef.current = messages.some((m) => m.streaming);

  const pinStreamingMessageTop = useCallback(() => {
    const dom = scrollRef.current;
    if (!dom) return;

    requestAnimationFrame(() => {
      /**
       * 两个条件缺一不可：
       *   - 这一帧执行时仍在流式输出（RAF 是异步的，生成可能已经结束）；
       *   - DOM 里确实还能找到「生成中的气泡」。
       *
       * 以前第二个条件不满足时会“先贴底”，结果生成结束的一瞬间被拽到最底部
       * （什么都不做却自己滚下去，且时有时无）。发送时的贴底由 resetFollow() 负责。
       */
      const el = dom.querySelector<HTMLElement>('[data-streaming="1"]');
      if (
        userScrolledRef.current ||
        !canPinStreamingScroll({
          streaming: streamingRef.current,
          hasStreamingElement: !!el,
        }) ||
        !el
      ) {
        return;
      }

      const domRect = dom.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      // 消息顶部在滚动内容里的位置
      const messageTop = elRect.top - domRect.top + dom.scrollTop;
      const { target, shouldScroll } = getStreamingPinTarget({
        scrollTop: dom.scrollTop,
        clientHeight: dom.clientHeight,
        scrollHeight: dom.scrollHeight,
        messageTop,
      });

      /**
       * 桌面端：把气泡顶部钉在画面顶部。
       *
       * 注意 *不要* 在列表末尾垫占位空白来「凑出」可滚动空间——
       * 那会在列表最底下留出一屏空白（滚到底或生成过程中都很明显）。
       * getStreamingPinTarget 已经把 target 夹到 maxScroll：
       *   - 答复还不满一屏 → target = maxScroll，等于跟到底部（没有空白）；
       *   - 答复超过一屏 → target = 气泡顶部，自然钉住。
       */
      if (pinStreamingTop) {
        dom.scrollTop = target;
        // 记录**实际**位置：内容不足一屏时浏览器会把 target 夹到 maxScroll，
        // 直接记 target 会让后续的“这是不是我们滚的”判断失配
        programmaticTargetRef.current = dom.scrollTop;
        return;
      }

      if (shouldScroll) {
        dom.scrollTop = target;
        programmaticTargetRef.current = dom.scrollTop;
      }
    });
  }, [scrollRef, pinStreamingTop]);

  /**
   * 流式输出期间：把气泡顶部钉在容器顶部。
   *
   * 生成结束后什么都不做——「完成后跳到底部」正是用户最烦的那一下，
   * 这里只保留「新消息」这一条贴底路径（由 messages.length 变化触发）。
   */
  useEffect(() => {
    const streaming = messages.some((m) => m.streaming);
    if (!streaming) {
      manualBottomRef.current = false;
      return;
    }
    // 用户已经接管滚动（往上翻 / 点了回到底部 / 自己滚过）就不再钉
    if (
      !shouldPinDuringStreaming({
        autoScroll,
        manualBottom: manualBottomRef.current,
        userScrolled: userScrolledRef.current,
      })
    ) {
      return;
    }

    pinStreamingMessageTop();
    // 故意不加依赖：它要在每次渲染后跟着流式内容走一遍
  });

  // auto scroll when messages length changes
  const lastMessagesLength = useRef(messages.length);
  useEffect(() => {
    if (messages.length > lastMessagesLength.current && !detach) {
      resetFollow();
    }
    lastMessagesLength.current = messages.length;
  }, [messages.length, detach, resetFollow]);

  return {
    scrollRef,
    autoScroll,
    setAutoScroll,
    scrollDomToBottom,
    scrollToBottomManual,
    resetFollow,
    consumeProgrammaticScroll,
    /** 告诉滚动逻辑「用户自己动过了」：这一轮不再钉顶部 */
    notifyUserScroll,
  };
}

/**
 * iOS 15 及更早的 Safari 不认 `overscroll-behavior`：
 * 消息列表滚到顶/底之后继续拖动，整个页面会跟着“回弹”。
 *
 * 支持该属性的浏览器交给 CSS 处理；不支持的才挂这个兜底：
 * 到达边缘时拦掉 touchmove，让列表停在原地。
 */
function usePreventOverscroll(ref: RefObject<HTMLDivElement>) {
  useEffect(() => {
    const dom = ref.current;
    if (!dom) return;

    if (
      typeof CSS !== "undefined" &&
      typeof CSS.supports === "function" &&
      CSS.supports("overscroll-behavior", "none")
    ) {
      return;
    }

    let startY = 0;
    /** 手指从一个可横向滚动的容器里开始：那种手势交给它自己处理 */
    let insideScrollable = false;

    const isInsideScrollable = (target: EventTarget | null) => {
      let el = target as HTMLElement | null;
      while (el && el !== dom && el instanceof HTMLElement) {
        const style = getComputedStyle(el);
        const scrollableX =
          (style.overflowX === "auto" || style.overflowX === "scroll") &&
          el.scrollWidth > el.clientWidth + 1;
        const scrollableY =
          (style.overflowY === "auto" || style.overflowY === "scroll") &&
          el.scrollHeight > el.clientHeight + 1;

        // 横向列表（代码块 / 表格 / 图片条）要优先响应横滑，
        // 否则生成过程中（列表停在底部）这些容器会完全滑不动
        if (scrollableX || scrollableY) return true;
        el = el.parentElement;
      }
      return false;
    };

    const onTouchStart = (e: TouchEvent) => {
      startY = e.touches[0]?.clientY ?? 0;
      insideScrollable = isInsideScrollable(e.target);
    };

    const onTouchMove = (e: TouchEvent) => {
      // 手势起点在内层可滚动容器里：让它自己滚，别拦住
      if (insideScrollable) return;

      const y = e.touches[0]?.clientY ?? 0;
      const delta = y - startY;
      const atTop = dom.scrollTop <= 0;
      const atBottom = dom.scrollTop + dom.clientHeight >= dom.scrollHeight - 1;

      // 手指往下拉（delta > 0）且已经在顶部 / 手指往上推且已经在底部
      if ((atTop && delta > 0) || (atBottom && delta < 0)) {
        e.preventDefault();
      }
    };

    dom.addEventListener("touchstart", onTouchStart, { passive: true });
    dom.addEventListener("touchmove", onTouchMove, { passive: false });

    return () => {
      dom.removeEventListener("touchstart", onTouchStart);
      dom.removeEventListener("touchmove", onTouchMove);
    };
  }, [ref]);
}

export function ChatActions(props: {
  uploadImage: () => void;
  /** 打开任意文件的选择框（文档 / 文本 / 表格） */
  uploadFile: () => void;
  setAttachImages: (images: string[]) => void;
  setUploading: (uploading: boolean) => void;
  showPromptModal: () => void;
  showPromptHints: () => void;
  uploading: boolean;
  setShowShortcutKeyModal: React.Dispatch<React.SetStateAction<boolean>>;
  setUserInput: (input: string) => void;
  setShowChatSidePanel: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const config = useAppConfig();
  const navigate = useNavigate();
  const chatStore = useChatStore();
  const pluginStore = usePluginStore();
  const session = chatStore.currentSession();

  // switch themes
  const theme = config.theme;

  function nextTheme() {
    const themes = [Theme.Auto, Theme.Light, Theme.Dark];
    const themeIndex = themes.indexOf(theme);
    const nextIndex = (themeIndex + 1) % themes.length;
    const nextTheme = themes[nextIndex];
    config.update((config) => (config.theme = nextTheme));
  }

  // stop all responses
  const couldStop = ChatControllerPool.hasPending();
  const stopAll = () => ChatControllerPool.stopAll();

  // switch model
  const currentModel = session.mask.modelConfig.model;
  const currentProviderName =
    session.mask.modelConfig?.providerName || ServiceProvider.OpenAI;
  const allModels = useAllModels();
  const models = useMemo(() => {
    const filteredModels = allModels.filter((m) => m.available);
    const defaultModel = filteredModels.find((m) => m.isDefault);

    if (defaultModel) {
      const arr = [
        defaultModel,
        ...filteredModels.filter((m) => m !== defaultModel),
      ];
      return arr;
    } else {
      return filteredModels;
    }
  }, [allModels]);
  const currentModelName = useMemo(() => {
    const model = models.find(
      (m) =>
        m.name == currentModel &&
        m?.provider?.providerName == currentProviderName,
    );
    return model?.displayName ?? "";
  }, [models, currentModel, currentProviderName]);
  const [showModelSelector, setShowModelSelector] = useState(false);
  const [showPluginSelector, setShowPluginSelector] = useState(false);
  const [showUploadImage, setShowUploadImage] = useState(false);

  const [showSizeSelector, setShowSizeSelector] = useState(false);
  const [showQualitySelector, setShowQualitySelector] = useState(false);
  const [showStyleSelector, setShowStyleSelector] = useState(false);
  const modelSizes = getModelSizes(currentModel);
  const dalle3Qualitys: DalleQuality[] = ["standard", "hd"];
  const dalle3Styles: DalleStyle[] = ["vivid", "natural"];
  const currentSize =
    session.mask.modelConfig?.size ?? ("1024x1024" as ModelSize);
  const currentQuality = session.mask.modelConfig?.quality ?? "standard";
  const currentStyle = session.mask.modelConfig?.style ?? "vivid";

  const isMobileScreen = useMobileScreen();

  useEffect(() => {
    const show = isVisionModel(currentModel);
    setShowUploadImage(show);
    if (!show) {
      props.setAttachImages([]);
      props.setUploading(false);
    }

    // if current model is not available
    // switch to first available model
    const isUnavailableModel = !models.some((m) => m.name === currentModel);
    if (isUnavailableModel && models.length > 0) {
      // show next model to default model if exist
      let nextModel = models.find((model) => model.isDefault) || models[0];
      chatStore.updateTargetSession(session, (session) => {
        session.mask.modelConfig.model = nextModel.name;
        session.mask.modelConfig.providerName = nextModel?.provider
          ?.providerName as ServiceProvider;
      });
      showToast(
        nextModel?.provider?.providerName == "ByteDance"
          ? nextModel.displayName
          : nextModel.name,
      );
    }
  }, [chatStore, currentModel, models, session]);

  return (
    <div className={styles["chat-input-actions"]}>
      <>
        {couldStop && (
          <ChatAction
            onClick={stopAll}
            text={Locale.Chat.InputActions.Stop}
            icon={<StopIcon />}
          />
        )}
        <ChatAction
          onClick={props.showPromptModal}
          text={Locale.Chat.InputActions.Settings}
          icon={<SettingsIcon />}
        />

        {showUploadImage && (
          <ChatAction
            onClick={props.uploadImage}
            text={Locale.Chat.InputActions.UploadImage}
            icon={props.uploading ? <LoadingButtonIcon /> : <ImageIcon />}
          />
        )}
        {showUploadImage && (
          <ChatAction
            onClick={props.uploadFile}
            text={Locale.Chat.Attachments.Button}
            icon={<UploadIcon />}
          />
        )}
        <ChatAction
          onClick={nextTheme}
          text={Locale.Chat.InputActions.Theme[theme]}
          icon={
            <>
              {theme === Theme.Auto ? (
                <AutoIcon />
              ) : theme === Theme.Light ? (
                <LightIcon />
              ) : theme === Theme.Dark ? (
                <DarkIcon />
              ) : null}
            </>
          }
        />

        <ChatAction
          onClick={props.showPromptHints}
          text={Locale.Chat.InputActions.Prompt}
          icon={<PromptIcon />}
        />

        <ChatAction
          onClick={() => {
            navigate(Path.Masks);
          }}
          text={Locale.Chat.InputActions.Masks}
          icon={<MaskIcon />}
        />

        {/*<ChatAction
          text={Locale.Chat.InputActions.Clear}
          icon={<BreakIcon />}
          onClick={() => {
            chatStore.updateTargetSession(session, (session) => {
              if (session.clearContextIndex === session.messages.length) {
                session.clearContextIndex = undefined;
              } else {
                session.clearContextIndex = session.messages.length;
                session.memoryPrompt = ""; // will clear memory
              }
            });
          }}
        />*/}

        <ChatAction
          onClick={() => setShowModelSelector(true)}
          text={currentModelName}
          icon={<RobotIcon />}
        />

        {showModelSelector && (
          <Selector
            defaultSelectedValue={`${currentModel}@${currentProviderName}`}
            items={models.map((m) => ({
              title: `${m.displayName}${
                m?.provider?.providerName
                  ? " (" + m?.provider?.providerName + ")"
                  : ""
              }`,
              value: `${m.name}@${m?.provider?.providerName}`,
            }))}
            onClose={() => setShowModelSelector(false)}
            onSelection={(s) => {
              if (s.length === 0) return;
              const [model, providerName] = getModelProvider(s[0]);
              chatStore.updateTargetSession(session, (session) => {
                session.mask.modelConfig.model = model as ModelType;
                session.mask.modelConfig.providerName =
                  providerName as ServiceProvider;
                session.mask.syncGlobalConfig = false;
              });
              if (providerName == "ByteDance") {
                const selectedModel = models.find(
                  (m) =>
                    m.name == model &&
                    m?.provider?.providerName == providerName,
                );
                showToast(selectedModel?.displayName ?? "");
              } else {
                showToast(model);
              }
            }}
          />
        )}

        {supportsCustomSize(currentModel) && (
          <ChatAction
            onClick={() => setShowSizeSelector(true)}
            text={currentSize}
            icon={<SizeIcon />}
          />
        )}

        {showSizeSelector && (
          <Selector
            defaultSelectedValue={currentSize}
            items={modelSizes.map((m) => ({
              title: m,
              value: m,
            }))}
            onClose={() => setShowSizeSelector(false)}
            onSelection={(s) => {
              if (s.length === 0) return;
              const size = s[0];
              chatStore.updateTargetSession(session, (session) => {
                session.mask.modelConfig.size = size;
              });
              showToast(size);
            }}
          />
        )}

        {isDalle3(currentModel) && (
          <ChatAction
            onClick={() => setShowQualitySelector(true)}
            text={currentQuality}
            icon={<QualityIcon />}
          />
        )}

        {showQualitySelector && (
          <Selector
            defaultSelectedValue={currentQuality}
            items={dalle3Qualitys.map((m) => ({
              title: m,
              value: m,
            }))}
            onClose={() => setShowQualitySelector(false)}
            onSelection={(q) => {
              if (q.length === 0) return;
              const quality = q[0];
              chatStore.updateTargetSession(session, (session) => {
                session.mask.modelConfig.quality = quality;
              });
              showToast(quality);
            }}
          />
        )}

        {isDalle3(currentModel) && (
          <ChatAction
            onClick={() => setShowStyleSelector(true)}
            text={currentStyle}
            icon={<StyleIcon />}
          />
        )}

        {showStyleSelector && (
          <Selector
            defaultSelectedValue={currentStyle}
            items={dalle3Styles.map((m) => ({
              title: m,
              value: m,
            }))}
            onClose={() => setShowStyleSelector(false)}
            onSelection={(s) => {
              if (s.length === 0) return;
              const style = s[0];
              chatStore.updateTargetSession(session, (session) => {
                session.mask.modelConfig.style = style;
              });
              showToast(style);
            }}
          />
        )}

        {showPlugins(currentProviderName, currentModel) && (
          <ChatAction
            onClick={() => {
              if (pluginStore.getAll().length == 0) {
                navigate(Path.Plugins);
              } else {
                setShowPluginSelector(true);
              }
            }}
            text={Locale.Plugin.Name}
            icon={<PluginIcon />}
          />
        )}
        {showPluginSelector && (
          <Selector
            multiple
            defaultSelectedValue={chatStore.currentSession().mask?.plugin}
            items={pluginStore.getAll().map((item) => ({
              title: `${item?.title}@${item?.version}`,
              value: item?.id,
            }))}
            onClose={() => setShowPluginSelector(false)}
            onSelection={(s) => {
              chatStore.updateTargetSession(session, (session) => {
                session.mask.plugin = s as string[];
              });
            }}
          />
        )}

        {!isMobileScreen && (
          <ChatAction
            onClick={() => props.setShowShortcutKeyModal(true)}
            text={Locale.Chat.ShortcutKey.Title}
            icon={<ShortcutkeyIcon />}
          />
        )}
        {!isMobileScreen && <MCPAction />}
      </>
      <div className={styles["chat-input-actions-end"]}>
        {config.realtimeConfig.enable && (
          <ChatAction
            onClick={() => props.setShowChatSidePanel(true)}
            text={"Realtime Chat"}
            icon={<HeadphoneIcon />}
          />
        )}
      </div>
    </div>
  );
}

export function EditMessageModal(props: { onClose: () => void }) {
  const chatStore = useChatStore();
  const session = chatStore.currentSession();
  const [messages, setMessages] = useState(session.messages.slice());

  return (
    <div className="modal-mask">
      <Modal
        title={Locale.Chat.EditMessage.Title}
        onClose={props.onClose}
        actions={[
          <IconButton
            text={Locale.UI.Cancel}
            icon={<CancelIcon />}
            key="cancel"
            onClick={() => {
              props.onClose();
            }}
          />,
          <IconButton
            type="primary"
            text={Locale.UI.Confirm}
            icon={<ConfirmIcon />}
            key="ok"
            onClick={() => {
              chatStore.updateTargetSession(
                session,
                (session) => (session.messages = messages),
              );
              props.onClose();
            }}
          />,
        ]}
      >
        <List>
          <ListItem
            title={Locale.Chat.EditMessage.Topic.Title}
            subTitle={Locale.Chat.EditMessage.Topic.SubTitle}
          >
            <input
              type="text"
              value={session.topic}
              onInput={(e) =>
                chatStore.updateTargetSession(
                  session,
                  (session) => (session.topic = e.currentTarget.value),
                )
              }
            ></input>
          </ListItem>
        </List>
        <ContextPrompts
          context={messages}
          updateContext={(updater) => {
            const newMessages = messages.slice();
            updater(newMessages);
            setMessages(newMessages);
          }}
        />
      </Modal>
    </div>
  );
}

export function DeleteImageButton(props: { deleteImage: () => void }) {
  return (
    <div className={styles["delete-image"]} onClick={props.deleteImage}>
      <DeleteIcon />
    </div>
  );
}

export function ShortcutKeyModal(props: { onClose: () => void }) {
  const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
  const shortcuts = [
    {
      title: Locale.Chat.ShortcutKey.newChat,
      keys: isMac ? ["⌘", "Shift", "O"] : ["Ctrl", "Shift", "O"],
    },
    { title: Locale.Chat.ShortcutKey.focusInput, keys: ["Shift", "Esc"] },
    {
      title: Locale.Chat.ShortcutKey.copyLastCode,
      keys: isMac ? ["⌘", "Shift", ";"] : ["Ctrl", "Shift", ";"],
    },
    {
      title: Locale.Chat.ShortcutKey.copyLastMessage,
      keys: isMac ? ["⌘", "Shift", "C"] : ["Ctrl", "Shift", "C"],
    },
    {
      title: Locale.Chat.ShortcutKey.showShortcutKey,
      keys: isMac ? ["⌘", "/"] : ["Ctrl", "/"],
    },
    {
      title: Locale.Chat.ShortcutKey.clearContext,
      keys: isMac
        ? ["⌘", "Shift", "backspace"]
        : ["Ctrl", "Shift", "backspace"],
    },
  ];
  return (
    <div className="modal-mask">
      <Modal
        title={Locale.Chat.ShortcutKey.Title}
        onClose={props.onClose}
        actions={[
          <IconButton
            type="primary"
            text={Locale.UI.Confirm}
            icon={<ConfirmIcon />}
            key="ok"
            onClick={() => {
              props.onClose();
            }}
          />,
        ]}
      >
        <div className={styles["shortcut-key-container"]}>
          <div className={styles["shortcut-key-grid"]}>
            {shortcuts.map((shortcut, index) => (
              <div key={index} className={styles["shortcut-key-item"]}>
                <div className={styles["shortcut-key-title"]}>
                  {shortcut.title}
                </div>
                <div className={styles["shortcut-key-keys"]}>
                  {shortcut.keys.map((key, i) => (
                    <div key={i} className={styles["shortcut-key"]}>
                      <span>{key}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </Modal>
    </div>
  );
}

function _Chat() {
  type RenderMessage = ChatMessage & { preview?: boolean };

  const chatStore = useChatStore();
  const session = chatStore.currentSession();
  const config = useAppConfig();
  const fontSize = config.fontSize;
  const fontFamily = config.fontFamily;

  const [showExport, setShowExport] = useState(false);
  // 调试用：查看某条消息的原始数据（存储原文 / 渲染输入 / JSON）
  const [debugMessage, setDebugMessage] = useState<ChatMessage | null>(null);
  // 点开气泡里的缩略图后，全屏看大图
  const [previewImage, setPreviewImage] = useState<string | null>(null);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [userInput, setUserInput] = useState("");

  /**
   * 当前输入框的「应有值」。
   * 发送后清空、载入提示词、引用消息都是我们主动改的，不会触发 input 事件，
   * 诊断逻辑需要靠它区分「我们自己改的」和「被系统吞掉的」。
   * 渲染期直接同步赋值，避免和 400ms 的静默检测抢时序。
   */
  const userInputRef = useRef(userInput);
  userInputRef.current = userInput;

  /**
   * 写入输入框内容 —— **只有这里可以改 textarea 的 DOM 值**。
   *
   * 为什么不用受控组件（value={userInput}）：
   *   iOS 15 的 WKWebView 会给文本服务（选中后的「翻译 / 查询」、听写、候选词替换）
   *   在 textarea 里维护一个**私有的 range 指针**；任何 JS 对 `textarea.value` 的写入
   *   都会让这个指针失效，系统操作回来之后按旧偏移去改文本 → 把文字吞掉。
   *   React 的受控 value 只要状态和 DOM 不一致就会写 value，正好踩这个坑。
   *
   * 现在的做法：textarea 非受控（defaultValue），用户输入只更新 state、不碰 DOM；
   * 只有「发送后清空 / 插入提示词 / 引用消息 / 恢复草稿」这类外部改动才走这个函数，
   * 而且**值相同就不写**（写入本身也会让 WebKit 的指针失效）。
   */
  const applyUserInput = useCallback((next: string) => {
    const el = inputRef.current;
    if (el && el.value !== next) {
      el.value = next;
    }
    userInputRef.current = next;
    setUserInput(next);
  }, []);

  /**
   * 输入框失焦期间的 `input` 事件计数 + 「有没有触发过 input」。
   *
   * 用来兜住 iOS 上「选中文字 → 点系统菜单的『翻译 / 查询』→ 文字被吞，而且
   * 一个 input 事件都没发」这条路径：
   *   - 正常输入 / 拼音选词 / 系统替换，一定会伴随 input 事件；
   *   - 只有“DOM 变了却没有任何 input 事件”才是真正被吞。
   *
   * 注意：这个判据和之前那版「内容变短就判定误删」完全不同——
   * 它不看长度，只看有没有事件，所以不会像以前那样误伤拼音输入。
   */
  const inputEventsWhileAwayRef = useRef(0);
  const isFocusedRef = useRef(false);

  const handleInputBlur = useCallback(() => {
    isFocusedRef.current = false;
    inputEventsWhileAwayRef.current = 0;
  }, []);

  const handleInputFocus = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    isFocusedRef.current = true;

    const expected = userInputRef.current;
    const lostSilently =
      inputEventsWhileAwayRef.current === 0 && el.value !== expected;
    if (lostSilently) {
      console.warn("[Input] text lost without any input event, restoring", {
        dom: el.value.length,
        expected: expected.length,
      });
      el.value = expected;
    }
  }, []);

  /**
   * iOS 15 的文本框诊断 + 误删兜底 —— **暂时关闭**。
   *
   * 关掉的原因：
   *   1. 误报：移动端用拼音输入时，如果把「前半部分拼音」选成候选词，
   *      输入框内容会短暂变短，这里就判定成“系统误删”并弹提示 + 回填，
   *      等于打断了正常输入；
   *   2. 漏报：真正被吞的场景（选中一段文字 → 点系统菜单的「翻译 / 查询」）
   *      反倒一个事件都收不到，兜底从来没触发过。
   *
   * 代码与日志能力都保留在 utils/input-diag.ts 里，需要时把下面这段放开即可
   * （或者只保留日志、把 onSuspect 去掉，见文件内注释）。
   */
  // useEffect(() => {
  //   const el = inputRef.current;
  //   if (!el) return;
  //   return attachInputDiagnostics(el, {
  //     label: "chat-input",
  //     getExpectedValue: () => userInputRef.current,
  //     onSuspect: (restored) => {
  //       setUserInput(restored);
  //       showToast(Locale.Chat.InputRestored);
  //     },
  //   });
  // }, []);
  const [isLoading, setIsLoading] = useState(false);
  const { submitKey, shouldSubmit } = useSubmitHandler();
  const scrollRef = useRef<HTMLDivElement>(null);
  const isScrolledToBottom = scrollRef?.current
    ? Math.abs(
        scrollRef.current.scrollHeight -
          (scrollRef.current.scrollTop + scrollRef.current.clientHeight),
      ) <= 1
    : false;
  const isAttachWithTop = useMemo(() => {
    const lastMessage = scrollRef.current?.lastElementChild as HTMLElement;
    // if scrolllRef is not ready or no message, return false
    if (!scrollRef?.current || !lastMessage) return false;
    const topDistance =
      lastMessage!.getBoundingClientRect().top -
      scrollRef.current.getBoundingClientRect().top;
    // leave some space for user question
    return topDistance < 100;
  }, [scrollRef?.current?.scrollHeight]);

  const isTyping = userInput !== "";
  const isMobileScreen = useMobileScreen();
  /**
   * 桌面端才把流式气泡钉在画面顶部。
   * 窄屏（手机）保持“跟到底部”的老行为：一屏矮，气泡很快就超过一屏，
   * 钉顶反而会让人看不到刚生成的内容。
   */
  const pinStreamingTop = !isMobileScreen;

  // if user is typing, should auto scroll to bottom
  // if user is not typing, should auto scroll to bottom only if already at bottom
  const {
    setAutoScroll,
    scrollDomToBottom,
    scrollToBottomManual,
    resetFollow,
    consumeProgrammaticScroll,
    notifyUserScroll,
  } = useScrollToBottom(
    scrollRef,
    (isScrolledToBottom || isAttachWithTop) && !isTyping,
    session.messages,
    pinStreamingTop,
  );
  // 老版本 iOS 上阻止列表滚到边缘后整页回弹
  usePreventOverscroll(scrollRef);

  /**
   * 进入会话时滚到底部。
   *
   * `_Chat` 是按 session.id 挂载的（见文件末尾的 key），所以每个会话只会跑一次。
   *
   * 为什么要“补几次”：首屏内容是渐进的——markdown 渲染、代码高亮、图片、
   * mermaid 都会在之后几帧里继续把内容撑高；只滚一次的话经常停在半路，
   * 表现就是「进对话随机停在中间」。这里每隔 150ms 再滚一次，最多 6 次，
   * 用户一旦自己滚动就立即停止（不跟用户抢滚动条）。
   */
  const initialScrollCancelledRef = useRef(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let tries = 0;

    const tick = () => {
      if (initialScrollCancelledRef.current) return;
      // 正在流式输出时不要抢滚动条：那种情况由「钉住/跟随」逻辑接管
      const streamingNow = useChatStore
        .getState()
        .currentSession()
        .messages.some((m) => m.streaming);
      if (streamingNow) return;
      scrollDomToBottom();
      tries += 1;
      if (tries < 6) timer = setTimeout(tick, 150);
    };

    tick();
    return () => {
      if (timer) clearTimeout(timer);
    };
    // 每个会话只做一次首屏定位
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  const [hitBottom, setHitBottom] = useState(true);
  const navigate = useNavigate();
  const [attachImages, setAttachImages] = useState<string[]>([]);
  /** 已上传（或上传中）的文件附件；图片仍走 attachImages */
  const [attachFiles, setAttachFiles] = useState<ChatAttachment[]>([]);
  /** 上传中 / 失败的状态：id → 文案 */
  const [attachStatus, setAttachStatus] = useState<Record<string, string>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  // prompt hints
  const promptStore = usePromptStore();
  const [promptHints, setPromptHints] = useState<RenderPrompt[]>([]);
  const onSearch = useDebouncedCallback(
    (text: string) => {
      const matchedPrompts = promptStore.search(text);
      setPromptHints(matchedPrompts);
    },
    100,
    { leading: true, trailing: true },
  );

  // auto grow input
  const [inputRows, setInputRows] = useState(2);
  const measure = useDebouncedCallback(
    () => {
      const rows = inputRef.current ? autoGrowTextArea(inputRef.current) : 1;
      const inputRows = Math.min(
        MAX_INPUT_ROWS,
        Math.max(2 + Number(!isMobileScreen), rows),
      );
      setInputRows(inputRows);
    },
    100,
    {
      leading: true,
      trailing: true,
    },
  );

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(measure, [userInput]);

  // chat commands shortcuts
  const chatCommands = useChatCommand({
    new: () => chatStore.newSession(),
    newm: () => navigate(Path.NewChat),
    prev: () => chatStore.nextSession(-1),
    next: () => chatStore.nextSession(1),
    fork: () => chatStore.forkSession(),
    del: () => chatStore.deleteSession(chatStore.currentSessionIndex),
  });

  // only search prompts when user input is short
  const SEARCH_TEXT_LIMIT = 30;
  const onInput = (text: string) => {
    setUserInput(text);
    const n = text.trim().length;

    // clear search results
    if (n === 0) {
      setPromptHints([]);
    } else if (text.match(ChatCommandPrefix)) {
      setPromptHints(chatCommands.search(text));
    } else if (!config.disablePromptHint && n < SEARCH_TEXT_LIMIT) {
      // check if need to trigger auto completion
      if (text.startsWith("/")) {
        let searchText = text.slice(1);
        onSearch(searchText);
      }
    }
  };

  const doSubmit = async (userInput: string) => {
    if (
      userInput.trim() === "" &&
      isEmpty(attachImages) &&
      attachFiles.length === 0
    ) {
      return;
    }
    const matchCommand = chatCommands.match(userInput);
    if (matchCommand.matched) {
      applyUserInput("");
      setPromptHints([]);
      matchCommand.invoke();
      return;
    }

    /**
     * 还有附件没传完（占位 chip 上没有 file_id）就先别发。
     *
     * 否则这条消息会“看起来带了附件、实际上什么也没带”：模型看不到，
     * 消息里也不会留下附件记录。
     */
    if (hasPendingAttachments(attachFiles)) {
      showToast(Locale.Chat.Attachments.StillUploading);
      return;
    }

    /**
     * 知识库检索（会话级开关，默认关闭）。
     *
     * 检索必须发生在「清空输入框」之前，因为调试模式下用户可能取消：
     * 取消时要把输入原样留在框里，也不能发请求。
     */
    let knowledge:
      | {
          text: string;
          sections: Array<{
            headingPath: string;
            docName: string;
            chars: number;
          }>;
          tokens: number;
        }
      | undefined;

    if (session.knowledge?.enabled) {
      try {
        const pinned = session.knowledge?.sectionIds ?? [];
        const result =
          pinned.length > 0
            ? // 手动勾选了片段：只注入这些，不再做检索
              // 预算比自动检索大得多：用户点名的片段不该被悄悄砍掉
              await useKnowledgeStore.getState().retrievePinned(pinned, {
                budgetTokens: PINNED_BUDGET_TOKENS,
              })
            : await useKnowledgeStore.getState().retrieve(userInput, {
                budgetTokens: 40000,
                candidates: 8,
                minChars: 200,
              });

        // 勾选里有失效 id（文档被删/换过）时，顺手清掉并告诉用户
        if (result.debug?.mode === "pinned" && result.debug.missingPinned) {
          const sections = await useKnowledgeStore.getState().listSections();
          const { kept, removed } = filterValidSectionIds(
            pinned,
            sections.map((section) => section.id),
          );
          if (removed.length > 0) {
            chatStore.updateTargetSession(session, (current) => {
              current.knowledge = { ...current.knowledge, sectionIds: kept };
            });
            showToast(Locale.Chat.Knowledge.PinnedPruned(removed.length));
          }
        }

        if (session.knowledge?.debugPreview) {
          // 预览要等用户点确定；取消就什么都不做
          const ok = await showKnowledgePreview(result);
          if (!ok) return;
        } else if (result.debug?.reason === "no-docs") {
          // 没开调试预览时，至少提示“库里还没东西”，否则用户只会觉得检索坏了
          showToast(Locale.Chat.Knowledge.EmptyNoDocs);
        } else if (result.debug?.reason === "no-match") {
          console.info("[Knowledge] no match", result.debug);
        }

        if (result.hits.length > 0) {
          knowledge = {
            text: result.text,
            sections: result.hits.map((hit) => ({
              // 只记 id：正文在发请求时按 id 现取，拼成 system 消息
              id: hit.chunk.id,
              headingPath: hit.chunk.headingPath || hit.chunk.heading,
              docName: hit.chunk.docName,
              chars: hit.chunk.chars,
            })),
            tokens: result.tokens,
          };
        }
      } catch (e) {
        console.error("[Knowledge] retrieve failed", e);
      }
    }

    setIsLoading(true);
    chatStore
      .onUserInput(userInput, attachImages, false, attachFiles, knowledge)
      .catch((error) => {
        // 正常情况下 onUserInput 内部已经吞掉了发送错误（消息先落库再发），
        // 这里只是兜底，避免出现 unhandled rejection 把页面带崩。
        console.error("[Chat] failed to send message", error);
      })
      .finally(() => setIsLoading(false));
    setAttachImages([]);
    setAttachFiles([]);
    chatStore.setLastInput(userInput);
    applyUserInput("");
    setPromptHints([]);
    if (!isMobileScreen) inputRef.current?.focus();
    // 新的一轮生成：清掉“用户要求停在底部”，允许重新钉到气泡顶部
    resetFollow();
  };

  const onPromptSelect = (prompt: RenderPrompt) => {
    setTimeout(() => {
      setPromptHints([]);

      const matchedChatCommand = chatCommands.match(prompt.content);
      if (matchedChatCommand.matched) {
        // if user is selecting a chat command, just trigger it
        matchedChatCommand.invoke();
        applyUserInput("");
      } else {
        // or fill the prompt
        applyUserInput(prompt.content);
      }
      inputRef.current?.focus();
    }, 30);
  };

  // stop response
  const onUserStop = (messageId: string) => {
    ChatControllerPool.stop(session.id, messageId);

    // 请求可能还在准备阶段（历史 / MCP 提示词还没拼完，此时没有 controller 可 abort）。
    // 先把界面上的“生成中”停掉，空占位会在 onUserInput/chatWithApi 收尾时清理。
    chatStore.updateTargetSession(session, (session) => {
      const message = session.messages.find((m) => m.id === messageId);
      if (!message?.streaming) return;
      message.streaming = false;
      session.messages = session.messages.concat();
    });
  };

  // 输入框右下角的圆球：生成中变成「停止」，平时是「发送」
  const isGenerating = session.messages.some((m) => m.streaming);
  const onStopAll = () => {
    session.messages
      .filter((m) => m.streaming)
      .forEach((m) => ChatControllerPool.stop(session.id, m.id ?? ""));

    chatStore.updateTargetSession(session, (session) => {
      let changed = false;
      session.messages.forEach((m) => {
        if (m.streaming) {
          m.streaming = false;
          changed = true;
        }
      });
      if (changed) session.messages = session.messages.concat();
    });
  };

  useEffect(() => {
    chatStore.updateTargetSession(session, (session) => {
      const stopTiming = Date.now() - REQUEST_TIMEOUT_MS;
      session.messages.forEach((m) => {
        // check if should stop all stale messages
        if (m.isError || new Date(m.date).getTime() < stopTiming) {
          if (m.streaming) {
            m.streaming = false;
          }

          if (m.content.length === 0) {
            m.isError = true;
            m.content = prettyObject({
              error: true,
              message: "empty response",
            });
          }
        }
      });

      // auto sync mask config from global config
      if (session.mask.syncGlobalConfig) {
        console.log("[Mask] syncing from global, name = ", session.mask.name);
        session.mask.modelConfig = { ...config.modelConfig };
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // check if should send message
  const onInputKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // if ArrowUp and no userInput, fill with last input
    if (
      e.key === "ArrowUp" &&
      userInput.length <= 0 &&
      !(e.metaKey || e.altKey || e.ctrlKey)
    ) {
      applyUserInput(chatStore.lastInput ?? "");
      e.preventDefault();
      return;
    }
    if (shouldSubmit(e) && promptHints.length === 0) {
      doSubmit(userInput);
      e.preventDefault();
    }
  };
  const onRightClick = (e: any, message: ChatMessage) => {
    // copy to clipboard
    if (selectOrCopy(e.currentTarget, getMessageTextContent(message))) {
      if (userInput.length === 0) {
        applyUserInput(getMessageTextContent(message));
      }

      e.preventDefault();
    }
  };

  const deleteMessage = (msgId?: string) => {
    chatStore.updateTargetSession(
      session,
      (session) =>
        (session.messages = session.messages.filter((m) => m.id !== msgId)),
    );
  };

  const onDelete = async (msgId: string) => {
    // 消息气泡上的删除按钮：先确认，避免手滑删掉整条回复
    if (!(await showConfirm(Locale.Chat.Actions.DeleteConfirm))) return;
    deleteMessage(msgId);
  };

  /**
   * 删除某条消息上的一个附件。
   *
   * 同时做三件事：从 attachments 里移除、把 content 里对应的 image_url / file 块删掉
   * （这样也不会再进入模型上下文）、尽力删掉云端文件。
   */
  const removeMessageAttachment = async (
    message: ChatMessage,
    attachmentId: string,
  ) => {
    const target = message.attachments?.find(
      (item) => item.id === attachmentId,
    );
    if (!target) return;
    if (!(await showConfirm(Locale.Chat.Attachments.DeleteConfirm))) return;

    chatStore.updateTargetSession(session, (session) => {
      const m = session.messages.find((item) => item.id === message.id);
      if (!m) return;
      m.attachments = (m.attachments ?? []).filter(
        (item) => item.id !== attachmentId,
      );
      if (Array.isArray(m.content)) {
        m.content = m.content.filter((block) => {
          if (block.type === "file") return block.file_id !== target.fileId;
          if (block.type === "image_url") {
            return block.image_url?.url !== target.url;
          }
          return true;
        });
      }
    });

    if (target.fileId) {
      const ok = await deleteFile(target.fileId);
      if (!ok) showToast(Locale.Chat.Attachments.DeleteFailed);
    }
  };

  const onResend = (message: ChatMessage) => {
    // when it is resending a message
    // 1. for a user's message, find the next bot response
    // 2. for a bot's message, find the last user's input
    // 3. delete original user input and bot's message
    // 4. resend the user's input

    const resendingIndex = session.messages.findIndex(
      (m) => m.id === message.id,
    );

    if (resendingIndex < 0 || resendingIndex >= session.messages.length) {
      console.error("[Chat] failed to find resending message", message);
      return;
    }

    let userMessage: ChatMessage | undefined;
    let botMessage: ChatMessage | undefined;

    if (message.role === "assistant") {
      // if it is resending a bot's message, find the user input for it
      botMessage = message;
      for (let i = resendingIndex; i >= 0; i -= 1) {
        if (session.messages[i].role === "user") {
          userMessage = session.messages[i];
          break;
        }
      }
    } else if (message.role === "user") {
      // if it is resending a user's input, find the bot's response
      userMessage = message;
      for (let i = resendingIndex; i < session.messages.length; i += 1) {
        if (session.messages[i].role === "assistant") {
          botMessage = session.messages[i];
          break;
        }
      }
    }

    if (userMessage === undefined) {
      console.error("[Chat] failed to resend", message);
      return;
    }

    // delete the original messages
    const messagesBeforeResend = session.messages.slice();
    deleteMessage(userMessage.id);
    deleteMessage(botMessage?.id);

    // resend the message
    setIsLoading(true);
    const textContent = getMessageTextContent(userMessage);
    const images = getMessageImages(userMessage);
    chatStore
      .onUserInput(textContent, images)
      .catch((error) => {
        console.error("[Chat] failed to resend message", error);
        // 极端情况下（新消息还没写进会话就抛错）把删掉的消息补回去，
        // 宁可多一条重复消息，也不能让用户的内容凭空消失。
        chatStore.updateTargetSession(
          session,
          (session) => (session.messages = messagesBeforeResend),
        );
      })
      .finally(() => setIsLoading(false));
    // 移动端不自动聚焦：会直接弹出键盘挡住内容
    if (!isMobileScreen) inputRef.current?.focus();
  };

  /**
   * 找到这条消息对应的回复：assistant 消息本身就是回复，
   * user 消息则取紧随其后的 assistant 消息。
   */
  const findReplyMessage = (message: ChatMessage) => {
    const index = session.messages.findIndex((m) => m.id === message.id);
    if (index < 0) return undefined;
    if (message.role === "assistant") return message;
    const next = session.messages[index + 1];
    return next?.role === "assistant" ? next : undefined;
  };

  /**
   * 重试：已经有回复时，为这条回复新增一个候选（旧回复保留），
   * 没有回复时回退到“删除后重新发送”。
   */
  const onRetry = (message: ChatMessage) => {
    // 重新生成 = 新的一轮：清掉「用户要求停在底部 / 已经钉住」的状态。
    // 以前这里调 scrollToBottom()，会把 manualBottom 置位，
    // 结果整段流式都不再钉住——表现就是“偶尔还是一路往下滚”。
    resetFollow();

    const reply = findReplyMessage(message);
    if (reply) {
      chatStore
        .regenerateMessage(session, reply.id)
        .catch((e) => console.error("[Chat] regenerate failed", e));
      // 不自动聚焦输入框：移动端会直接弹出键盘，盖住刚生成的回复
      return;
    }
    onResend(message);
  };

  /**
   * 继续生成：把这条未完成的回复当作前缀，让模型接着写。
   * 目前只有实现了前缀补全的 provider（DeepSeek beta）能用。
   */
  const onContinue = (message: ChatMessage) => {
    const provider = session.mask.modelConfig.providerName;
    if (!getClientApi(provider).llm.supportsPrefixCompletion) {
      showToast(Locale.Chat.Actions.ContinueUnsupported);
      return;
    }

    chatStore
      .continueMessage(session, message.id)
      .catch((e) => console.error("[Chat] continue failed", e));
  };

  const accessStore = useAccessStore();
  const [speechStatus, setSpeechStatus] = useState(false);
  const [speechLoading, setSpeechLoading] = useState(false);

  async function openaiSpeech(text: string) {
    if (speechStatus) {
      ttsPlayer.stop();
      setSpeechStatus(false);
    } else {
      var api: ClientApi;
      api = new ClientApi(ModelProvider.GPT);
      const config = useAppConfig.getState();
      setSpeechLoading(true);
      ttsPlayer.init();
      let audioBuffer: ArrayBuffer;
      const { markdownToTxt } = require("markdown-to-txt");
      const textContent = markdownToTxt(text);
      if (config.ttsConfig.engine !== DEFAULT_TTS_ENGINE) {
        const edgeVoiceName = accessStore.edgeVoiceName();
        const tts = new MsEdgeTTS();
        await tts.setMetadata(
          edgeVoiceName,
          OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3,
        );
        audioBuffer = await tts.toArrayBuffer(textContent);
      } else {
        audioBuffer = await api.llm.speech({
          model: config.ttsConfig.model,
          input: textContent,
          voice: config.ttsConfig.voice,
          speed: config.ttsConfig.speed,
        });
      }
      setSpeechStatus(true);
      ttsPlayer
        .play(audioBuffer, () => {
          setSpeechStatus(false);
        })
        .catch((e) => {
          console.error("[OpenAI Speech]", e);
          showToast(prettyObject(e));
          setSpeechStatus(false);
        })
        .finally(() => setSpeechLoading(false));
    }
  }

  const context: RenderMessage[] = useMemo(() => {
    return session.mask.hideContext ? [] : session.mask.context.slice();
  }, [session.mask.context, session.mask.hideContext]);

  if (
    context.length === 0 &&
    session.messages.at(0)?.content !== BOT_HELLO.content
  ) {
    const copiedHello = Object.assign({}, BOT_HELLO);
    if (!accessStore.isAuthorized()) {
      copiedHello.content = Locale.Error.Unauthorized;
    }
    context.push(copiedHello);
  }

  // preview messages
  /**
   * 只有「最近一条引用了知识库的用户消息」显示引用标记。
   *
   * 历史里每条都挂一个会让列表很吵，而且旧消息上的数字也可能早就过期；
   * 只需要看到本轮到底注入了什么。
   */
  /** 有没有消息正在流式输出（决定要不要垫占位空白） */
  const isStreaming = useMemo(
    () => session.messages.some((message) => message.streaming),
    [session.messages],
  );

  const lastKnowledgeMessageId = useMemo(() => {
    for (let i = session.messages.length - 1; i >= 0; i -= 1) {
      const message = session.messages[i];
      if (message.role === "user" && message.retrieval?.sections?.length) {
        return message.id;
      }
    }
    return "";
  }, [session.messages]);

  const renderMessages = useMemo(() => {
    // 已经有真正的“生成中”消息时，不要再补一个 "……" 的占位气泡，
    // 否则重新生成的瞬间会同时出现两条 assistant 占位
    const hasStreamingMessage = session.messages.some((m) => m.streaming);

    return context
      .concat(session.messages as RenderMessage[])
      .concat(
        isLoading && !hasStreamingMessage
          ? [
              {
                ...createMessage({
                  role: "assistant",
                  content: "……",
                }),
                preview: true,
              },
            ]
          : [],
      )
      .concat(
        userInput.length > 0 && config.sendPreviewBubble
          ? [
              {
                ...createMessage({
                  role: "user",
                  content: userInput,
                }),
                preview: true,
              },
            ]
          : [],
      );
  }, [
    config.sendPreviewBubble,
    context,
    isLoading,
    session.messages,
    userInput,
  ]);

  // 低占用模式：渲染窗口更小（3 * chatPageSize 条），DOM / markdown 内存随之下降
  const lowMemory = useLowMemoryStore((state) => state.enabled);
  const chatPageSize = lowMemory ? 6 : CHAT_PAGE_SIZE;

  const [msgRenderIndex, _setMsgRenderIndex] = useState(
    Math.max(0, renderMessages.length - chatPageSize),
  );

  function setMsgRenderIndex(newIndex: number) {
    // 允许一直退到 0：短会话（16~29 条）以前被夹在上限上，
    // 最早的几条永远渲染不出来
    _setMsgRenderIndex(
      clampRenderIndex(renderMessages.length, chatPageSize, newIndex),
    );
  }

  // 切换会话时重置渲染窗口：否则从长会话切到短会话还会沿用旧下标，窗口落空
  useEffect(() => {
    _setMsgRenderIndex(Math.max(0, renderMessages.length - chatPageSize));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  const messages = useMemo(() => {
    // 起始下标再兜一次底：状态可能是上一个会话留下的，越界会让窗口落空
    const start = clampRenderIndex(
      renderMessages.length,
      chatPageSize,
      msgRenderIndex,
    );
    const end = Math.min(start + 3 * chatPageSize, renderMessages.length);
    return renderMessages.slice(start, end);
  }, [msgRenderIndex, renderMessages, chatPageSize]);

  /**
   * 唯一一条还能“重新生成”的消息：
   * 末尾是 assistant → 就是它；末尾是还没回复的 user → 就是那条 user。
   * 更早的消息属于历史，只保留复制 / 查看原始内容 / 编辑。
   */
  const regeneratableId = useMemo(() => {
    const list = session.messages;
    for (let i = list.length - 1; i >= 0; i--) {
      const role = list[i].role;
      if (role === "assistant" || role === "user") return list[i].id;
    }
    return undefined;
  }, [session.messages]);

  // 分页窗口变化时用来“固定”视口：记录一条消息及其位置，渲染完后把滚动条
  // 挪回去，避免往上下补内容时整个画面跳走
  const scrollAnchorRef = useRef<{
    id: string;
    offset: number;
    mode: "top" | "bottom";
  } | null>(null);

  const captureScrollAnchor = (dom: HTMLElement, mode: "top" | "bottom") => {
    const items = Array.from(
      dom.querySelectorAll<HTMLElement>("[data-msg-id]"),
    );
    if (items.length === 0) {
      return;
    }

    const domRect = dom.getBoundingClientRect();

    if (mode === "top") {
      // 视口里最靠上、还露在外面的那条消息
      const first = items.find(
        (el) => el.getBoundingClientRect().bottom > domRect.top + 1,
      );
      if (!first) return;
      scrollAnchorRef.current = {
        id: first.dataset.msgId ?? "",
        offset: first.getBoundingClientRect().top,
        mode,
      };
      return;
    }

    // 往下翻页时锚定最靠下、还露在外面的那条消息
    const last = [...items]
      .reverse()
      .find((el) => el.getBoundingClientRect().top < domRect.bottom - 1);
    if (!last) return;
    scrollAnchorRef.current = {
      id: last.dataset.msgId ?? "",
      offset: last.getBoundingClientRect().bottom,
      mode,
    };
  };

  useLayoutEffect(() => {
    const anchor = scrollAnchorRef.current;
    if (!anchor) return;
    scrollAnchorRef.current = null;

    const dom = scrollRef.current;
    if (!dom) return;

    const el = Array.from(
      dom.querySelectorAll<HTMLElement>("[data-msg-id]"),
    ).find((node) => node.dataset.msgId === anchor.id);
    if (!el) return;

    const rect = el.getBoundingClientRect();
    const current = anchor.mode === "top" ? rect.top : rect.bottom;
    // 把锚定的那条消息挪回原来的位置
    dom.scrollTop += current - anchor.offset;
  }, [msgRenderIndex]);

  // 装不满一屏时主动往前补历史：这种内容高度下滚动条没有可滚动空间，
  // scroll 事件不会触发，“滚到顶部加载更多”永远等不到
  useLayoutEffect(() => {
    const dom = scrollRef.current;
    if (!dom) return;

    // 只要窗口前面还有消息就能往前补，不再要求「整整一页」
    if (!canLoadEarlier(msgRenderIndex)) return;
    if (!isScrollContentShort(dom)) return;

    captureScrollAnchor(dom, "top");
    setMsgRenderIndex(prevPageIndex(msgRenderIndex, chatPageSize));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msgRenderIndex, chatPageSize]);

  /** 流式进行中（用于区分“跟随底部”和“钉住气泡顶部”两种滚动策略） */
  const isStreamingNow = session.messages.some((m) => m.streaming);
  /** 上一次滚动位置：判断用户是不是在往上翻 */
  const lastScrollTopRef = useRef(0);

  const onChatBodyScroll = (e: HTMLElement) => {
    // 我们自己滚动产生的 scroll 事件：只更新记录，不当成用户操作
    if (consumeProgrammaticScroll(e.scrollTop)) {
      lastScrollTopRef.current = e.scrollTop;
      return;
    }

    // 用户自己动了滚动条：停掉“进入会话时补滚到底部”的重试，不跟他抢
    initialScrollCancelledRef.current = true;

    // 位移足够大才算“用户真的滚了”：内容增长时浏览器自己夹一下 scrollTop
    // 也会触发 scroll 事件，那种不该被当成用户操作（否则一生成就停止钉顶）
    if (Math.abs(e.scrollTop - lastScrollTopRef.current) > 8) {
      notifyUserScroll();
    }

    const prevPageMsgIndex = prevPageIndex(msgRenderIndex, chatPageSize);
    const nextPageMsgIndex = msgRenderIndex + chatPageSize;
    const canLoadPrev = canLoadEarlier(msgRenderIndex);
    // 窗口后面还有没渲染的消息时，当前位置只是“已加载部分的底部”，
    // 不能算真正的底部，否则一到底就会自动滚到最后一条
    const canLoadNext =
      msgRenderIndex + 3 * chatPageSize < renderMessages.length;

    const { isTouchTopEdge, isTouchBottomEdge, isHitBottom } =
      getChatScrollState({
        scrollTop: e.scrollTop,
        clientHeight: e.clientHeight,
        scrollHeight: e.scrollHeight,
        isMobile: isMobileScreen,
        hasMoreBelow: canLoadNext,
      });

    if (isTouchTopEdge && !isTouchBottomEdge && canLoadPrev) {
      captureScrollAnchor(e, "top");
      setMsgRenderIndex(prevPageMsgIndex);
    } else if (isTouchBottomEdge && canLoadNext) {
      if (isHitBottom) {
        scrollDomToBottom();
      } else {
        captureScrollAnchor(e, "bottom");
      }
      setMsgRenderIndex(nextPageMsgIndex);
    }

    setHitBottom(isHitBottom);

    /**
     * 流式期间：我们自己把气泡顶到顶部的滚动会让「不在底部」，
     * 不能因为这样就关掉自动跟随（否则气泡会慢慢飘走，就是 PC 上
     * “有时跟着滚、有时不跟”的来源）。只有用户**主动往上翻**才停。
     */
    if (isStreamingNow) {
      if (e.scrollTop < lastScrollTopRef.current - 2) {
        setAutoScroll(false);
      }
    } else {
      setAutoScroll(isHitBottom);
    }
    lastScrollTopRef.current = e.scrollTop;
  };

  function scrollToBottom() {
    setMsgRenderIndex(renderMessages.length - chatPageSize);
    // 用户主动回到底部：流式期间也不要再把他拽回气泡顶部
    scrollToBottomManual();
  }

  // clear context index = context length + index in messages
  const clearContextIndex =
    (session.clearContextIndex ?? -1) >= 0
      ? session.clearContextIndex! + context.length - msgRenderIndex
      : -1;

  const [showPromptModal, setShowPromptModal] = useState(false);
  // 单条会话上传：进行中时按钮禁用，避免连点
  const [uploadingSession, setUploadingSession] = useState(false);
  const syncStore = useSyncStore();
  const knowledgeStore = useKnowledgeStore();

  const clientConfig = useMemo(() => getClientConfig(), []);

  const autoFocus = !isMobileScreen; // wont auto focus on mobile screen
  const showMaxIcon = !isMobileScreen && !clientConfig?.isApp;

  useCommand({
    fill: setUserInput,
    submit: (text) => {
      doSubmit(text);
    },
    code: (text) => {
      if (accessStore.disableFastLink) return;
      console.log("[Command] got code from url: ", text);
      showConfirm(Locale.URLCommand.Code + `code = ${text}`).then((res) => {
        if (res) {
          accessStore.update((access) => (access.accessCode = text));
        }
      });
    },
    settings: (text) => {
      if (accessStore.disableFastLink) return;

      try {
        const payload = JSON.parse(text) as {
          key?: string;
          url?: string;
        };

        console.log("[Command] got settings from url: ", payload);

        if (payload.key || payload.url) {
          showConfirm(
            Locale.URLCommand.Settings +
              `\n${JSON.stringify(payload, null, 4)}`,
          ).then((res) => {
            if (!res) return;
            if (payload.key) {
              accessStore.update(
                (access) => (access.openaiApiKey = payload.key!),
              );
            }
            if (payload.url) {
              accessStore.update((access) => (access.openaiUrl = payload.url!));
            }
            accessStore.update((access) => (access.useCustomConfig = true));
          });
        }
      } catch {
        console.error("[Command] failed to get settings from url: ", text);
      }
    },
  });

  // edit / insert message modal
  const [isEditingMessage, setIsEditingMessage] = useState(false);

  // remember unfinished input
  useEffect(() => {
    // try to load from local storage
    const key = UNFINISHED_INPUT(session.id);
    const mayBeUnfinishedInput = localStorage.getItem(key);
    if (mayBeUnfinishedInput && userInput.length === 0) {
      applyUserInput(mayBeUnfinishedInput);
      localStorage.removeItem(key);
    }

    const dom = inputRef.current;
    return () => {
      localStorage.setItem(key, dom?.value ?? "");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handlePaste = useCallback(
    async (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const currentModel = chatStore.currentSession().mask.modelConfig.model;
      if (!isVisionModel(currentModel)) {
        return;
      }
      const items = (event.clipboardData || window.clipboardData).items;
      for (const item of items) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          event.preventDefault();
          const file = item.getAsFile();
          if (file) {
            const images: string[] = [...attachImages];

            setUploading(true);
            try {
              images.push(await uploadImageRemote(file));
            } catch (e: any) {
              console.error(
                "[Image] 粘贴图片处理失败",
                file.type || "(unknown type)",
                file.size,
                e,
              );
              showToast(
                `${Locale.Chat.Actions.ImageUploadFailed}${
                  e?.message ? `: ${e.message}` : ""
                }`,
              );
            } finally {
              setUploading(false);
            }

            const imagesLength = images.length;

            if (imagesLength > 3) {
              images.splice(3, imagesLength - 3);
            }
            setAttachImages(images);
          }
        }
      }
    },
    [attachImages, chatStore],
  );

  /** 选图：input 必须挂到 DOM 上，否则老版本 iOS Safari 不会触发 change */
  function pickImages(): Promise<File[]> {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      // 老 iOS 更喜欢通配符；写死 heic/heif 有时会让选择器失效
      input.accept = "image/*";
      input.multiple = true;
      input.style.display = "none";

      const finish = (files: File[]) => {
        input.remove();
        resolve(files);
      };

      input.onchange = () => {
        finish(Array.from(input.files ?? []));
      };
      // 部分浏览器支持取消事件；不支持时 Promise 会一直挂着，但没有副作用
      (input as any).oncancel = () => finish([]);

      // 挂到固定的弹层容器里，不要直接往 document.body 增删节点
      // （body 的子节点归 React 管，外部增删会让它后面对不上）
      getPortalHost().appendChild(input);
      input.click();
    });
  }

  async function uploadImage() {
    const files = await pickImages();
    if (files.length === 0) {
      return;
    }

    const images: string[] = [...attachImages];
    const remaining = Math.max(0, 3 - images.length);

    setUploading(true);
    try {
      for (const file of files.slice(0, remaining)) {
        try {
          images.push(await uploadImageRemote(file));
        } catch (e: any) {
          console.error(
            "[Image] 处理失败",
            file.type || "(unknown type)",
            file.size,
            e,
          );
          showToast(
            `${Locale.Chat.Actions.ImageUploadFailed}${
              e?.message ? `: ${e.message}` : ""
            }`,
          );
        }
      }
    } finally {
      setUploading(false);
    }

    if (images.length > 3) {
      images.splice(3, images.length - 3);
    }
    setAttachImages(images);
  }

  /**
   * 选择并上传文件（文档 / 文本 / 表格…）。
   *
   * 选完立即上传到 DeepSeek Files API，拿到 file_id 后挂在输入框上；
   * 发送时只把这个 id 放进 content 的 file 块里。图片仍然走 attachImages。
   */
  async function uploadAttachFiles(picked: File[]) {
    if (picked.length === 0) return;

    const room = Math.max(0, MAX_ATTACHMENTS - attachFiles.length);
    if (room === 0) {
      showToast(Locale.Chat.Attachments.TooMany(MAX_ATTACHMENTS));
      return;
    }

    setUploading(true);
    try {
      for (const file of picked.slice(0, room)) {
        const isImage = isImageFile(file);
        if (!getUploadPurpose(file.name, isImage)) {
          showToast(Locale.Chat.Attachments.Unsupported(file.name));
          continue;
        }
        const maxMB = getMaxSizeMB(file.name, isImage);
        if (file.size > maxMB * 1024 * 1024) {
          showToast(Locale.Chat.Attachments.TooLarge(file.name, maxMB));
          continue;
        }

        const localId = `pending-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 8)}`;
        // 先挂一个占位 chip：大文件上传要几秒，没有反馈会让人以为没反应
        setAttachFiles((list) => [
          ...list,
          {
            id: localId,
            kind: isImage ? "image" : "file",
            name: file.name,
            bytes: file.size,
            mime: file.type,
          },
        ]);
        setAttachStatus((status) => ({
          ...status,
          [localId]: Locale.Chat.Attachments.Uploading,
        }));

        try {
          const object = await uploadFile(file);
          const attachment = toChatAttachment(file, object);
          // 上传完成：把占位 chip 换成真正带 file_id 的附件
          setAttachFiles((list) =>
            list.map((item) => (item.id === localId ? attachment : item)),
          );
        } catch (e: any) {
          console.error("[Files] upload failed", file.name, e);
          setAttachFiles((list) => list.filter((item) => item.id !== localId));
          showToast(Locale.Chat.Attachments.UploadFailed(e?.message ?? ""));
        } finally {
          setAttachStatus((status) => {
            const next = { ...status };
            delete next[localId];
            return next;
          });
        }
      }
    } finally {
      setUploading(false);
    }
  }

  /** 删除一个附件：先尝试删云端文件，再把它从输入框移除 */
  async function removeAttachFile(id: string) {
    const target = attachFiles.find((item) => item.id === id);
    setAttachFiles((list) => list.filter((item) => item.id !== id));
    if (target?.fileId) {
      const ok = await deleteFile(target.fileId);
      if (!ok) {
        showToast(Locale.Chat.Attachments.DeleteFailed);
      }
    }
  }

  // 快捷键 shortcut keys
  const [showShortcutKeyModal, setShowShortcutKeyModal] = useState(false);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // 打开新聊天 command + shift + o
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "o"
      ) {
        event.preventDefault();
        setTimeout(() => {
          chatStore.newSession();
          navigate(Path.Chat);
        }, 10);
      }
      // 聚焦聊天输入 shift + esc
      else if (event.shiftKey && event.key.toLowerCase() === "escape") {
        event.preventDefault();
        inputRef.current?.focus();
      }
      // 复制最后一个代码块 command + shift + ;
      else if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.code === "Semicolon"
      ) {
        event.preventDefault();
        const copyCodeButton =
          document.querySelectorAll<HTMLElement>(".copy-code-button");
        if (copyCodeButton.length > 0) {
          copyCodeButton[copyCodeButton.length - 1].click();
        }
      }
      // 复制最后一个回复 command + shift + c
      else if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "c"
      ) {
        event.preventDefault();
        const lastNonUserMessage = messages
          .filter((message) => message.role !== "user")
          .pop();
        if (lastNonUserMessage) {
          const lastMessageContent = getMessageTextContent(lastNonUserMessage);
          copyToClipboard(lastMessageContent);
        }
      }
      // 展示快捷键 command + /
      else if ((event.metaKey || event.ctrlKey) && event.key === "/") {
        event.preventDefault();
        setShowShortcutKeyModal(true);
      }
      {
        /*
      // 清除上下文 command + shift + backspace
      else if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "backspace"
      ) {
        event.preventDefault();
        chatStore.updateTargetSession(session, (session) => {
          if (session.clearContextIndex === session.messages.length) {
            session.clearContextIndex = undefined;
          } else {
            session.clearContextIndex = session.messages.length;
            session.memoryPrompt = ""; // will clear memory
          }
        });
      }*/
      }
    };

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [messages, chatStore, navigate, session]);

  const [showChatSidePanel, setShowChatSidePanel] = useState(false);

  return (
    <>
      <div className={styles.chat} key={session.id}>
        <div className="window-header" data-tauri-drag-region>
          {isMobileScreen && (
            <div className="window-actions">
              <div className={"window-action-button"}>
                <IconButton
                  icon={<ReturnIcon />}
                  bordered
                  title={Locale.Chat.Actions.ChatList}
                  onClick={() => navigate(Path.Home)}
                />
              </div>
            </div>
          )}

          <div
            className={clsx("window-header-title", styles["chat-body-title"])}
          >
            <div
              className={clsx(
                "window-header-main-title",
                styles["chat-body-main-title"],
              )}
              onClickCapture={() => setIsEditingMessage(true)}
            >
              {!session.topic ? DEFAULT_TOPIC : session.topic}
            </div>
            <div className="window-header-sub-title">
              {config.showChatSubTitle !== false &&
                Locale.Chat.SubTitle(session.messages.length)}
            </div>
          </div>
          <div className="window-actions">
            {/*
              只上传当前这条会话：改完随手点一下就行，
              不用跑去设置页做全量上传（那条路会把整个历史都推一遍）。
            */}
            {syncStore.cloudSync() && (
              <div className="window-action-button">
                <IconButton
                  icon={<UploadIcon />}
                  bordered
                  disabled={uploadingSession}
                  title={Locale.Chat.Actions.UploadSession}
                  aria={Locale.Chat.Actions.UploadSession}
                  onClick={async () => {
                    if (uploadingSession) return;
                    setUploadingSession(true);
                    showToast(Locale.Chat.Actions.UploadingSession);
                    try {
                      const stats = await uploadSessionNow(session.id);
                      showToast(
                        stats.total === 0
                          ? Locale.Chat.Actions.UploadNothingChanged
                          : Locale.Chat.Actions.UploadSessionDone,
                      );
                    } catch (e: any) {
                      const locked = String(e?.message ?? "").includes(
                        "encryption",
                      );
                      showToast(
                        locked
                          ? Locale.Settings.Sync.Encryption.Locked
                          : Locale.Chat.Actions.UploadSessionFailed,
                      );
                      console.error("[Upload session]", e);
                    } finally {
                      setUploadingSession(false);
                    }
                  }}
                />
              </div>
            )}
            {config.showRefreshTitleButton !== false && (
              <div className="window-action-button">
                <IconButton
                  icon={<ReloadIcon />}
                  bordered
                  title={Locale.Chat.Actions.RefreshTitle}
                  onClick={() => {
                    showToast(Locale.Chat.Actions.RefreshToast);
                    chatStore.summarizeSession(true, session);
                  }}
                />
              </div>
            )}
            {!isMobileScreen && (
              <div className="window-action-button">
                <IconButton
                  icon={<RenameIcon />}
                  bordered
                  title={Locale.Chat.EditMessage.Title}
                  aria={Locale.Chat.EditMessage.Title}
                  onClick={() => setIsEditingMessage(true)}
                />
              </div>
            )}
            <div className="window-action-button">
              <IconButton
                icon={<ExportIcon />}
                bordered
                title={Locale.Chat.Actions.Export}
                onClick={() => {
                  setShowExport(true);
                }}
              />
            </div>
            {showMaxIcon && (
              <div className="window-action-button">
                <IconButton
                  icon={config.tightBorder ? <MinIcon /> : <MaxIcon />}
                  bordered
                  title={Locale.Chat.Actions.FullScreen}
                  aria={Locale.Chat.Actions.FullScreen}
                  onClick={() => {
                    config.update(
                      (config) => (config.tightBorder = !config.tightBorder),
                    );
                  }}
                />
              </div>
            )}
          </div>

          <PromptToast
            showModal={showPromptModal}
            setShowModal={setShowPromptModal}
          />
        </div>
        <div className={styles["chat-main"]}>
          <div className={styles["chat-body-container"]}>
            <div
              className={styles["chat-body"]}
              ref={scrollRef}
              onScroll={(e) => onChatBodyScroll(e.currentTarget)}
              onMouseDown={() => inputRef.current?.blur()}
              onTouchStart={() => {
                // 只收起输入框；不要把 autoScroll 关掉——
                // 点“重新生成”之类的按钮也会触发 touchstart，
                // 一关掉就不会再跟随新的底部了（滚动方向交给 onScroll 判断）
                inputRef.current?.blur();
              }}
            >
              {messages
                // TODO
                // .filter((m) => !m.isMcpResponse)
                .map((message, i) => {
                  const isUser = message.role === "user";
                  const isContext = i < context.length;
                  // 同一条消息里图片会用到好几次，别每次都重新遍历 content
                  const messageImages = getMessageImages(message);
                  const showActions = shouldShowMessageActions(
                    message,
                    isContext,
                    i,
                  );
                  const showTyping = message.preview || message.streaming;

                  const shouldShowClearContextDivider =
                    i === clearContextIndex - 1;

                  return (
                    <Fragment key={message.id}>
                      <div
                        // 分页滚动时用它把视口钉在这条消息上
                        data-msg-id={String(message.id ?? i)}
                        // 流式输出时用来定位“正在生成的那条消息”（滚动上限）
                        data-streaming={message.streaming ? "1" : undefined}
                        className={
                          isUser
                            ? styles["chat-message-user"]
                            : styles["chat-message"]
                        }
                      >
                        <div className={styles["chat-message-container"]}>
                          <div className={styles["chat-message-header"]}>
                            <div className={styles["chat-message-avatar"]}>
                              <div className={styles["chat-message-edit"]}>
                                <IconButton
                                  icon={<EditIcon />}
                                  aria={Locale.Chat.Actions.Edit}
                                  onClick={async () => {
                                    const newMessage = await showPrompt(
                                      Locale.Chat.Actions.Edit,
                                      getMessageTextContent(message),
                                      10,
                                    );
                                    let newContent:
                                      | string
                                      | MultimodalContent[] = newMessage;
                                    const images = getMessageImages(message);
                                    if (images.length > 0) {
                                      newContent = [
                                        { type: "text", text: newMessage },
                                      ];
                                      for (let i = 0; i < images.length; i++) {
                                        newContent.push({
                                          type: "image_url",
                                          image_url: {
                                            url: images[i],
                                          },
                                        });
                                      }
                                    }
                                    chatStore.updateTargetSession(
                                      session,
                                      (session) => {
                                        const m = session.mask.context
                                          .concat(session.messages)
                                          .find((m) => m.id === message.id);
                                        if (m) {
                                          m.content = newContent;
                                        }
                                      },
                                    );
                                  }}
                                ></IconButton>
                              </div>
                              {isUser ? (
                                <Avatar avatar={config.avatar} />
                              ) : (
                                <>
                                  {["system"].includes(message.role) ? (
                                    <Avatar avatar="2699-fe0f" />
                                  ) : (
                                    <MaskAvatar
                                      avatar={session.mask.avatar}
                                      model={
                                        message.model ||
                                        session.mask.modelConfig.model
                                      }
                                    />
                                  )}
                                </>
                              )}
                            </div>

                            {showActions && (
                              <div className={styles["chat-message-actions"]}>
                                <div className={styles["chat-input-actions"]}>
                                  {message.streaming ? (
                                    <ChatAction
                                      text={Locale.Chat.Actions.Stop}
                                      icon={<StopIcon />}
                                      onClick={() =>
                                        onUserStop(message.id ?? i)
                                      }
                                    />
                                  ) : (
                                    <>
                                      {message.role !== "system" &&
                                        message.id === regeneratableId && (
                                          <ChatAction
                                            text={Locale.Chat.Actions.Retry}
                                            icon={<ResetIcon />}
                                            onClick={() => onRetry(message)}
                                          />
                                        )}

                                      {/* 只有“未完成”的回复才显示继续生成（前缀补全） */}
                                      {message.role === "assistant" &&
                                        message.id === regeneratableId &&
                                        message.isComplete === false && (
                                          <ChatAction
                                            text={
                                              Locale.Chat.Actions
                                                .ContinueGenerate
                                            }
                                            icon={<PlayIcon />}
                                            onClick={() => onContinue(message)}
                                          />
                                        )}

                                      {message.role !== "system" &&
                                        message.id === regeneratableId && (
                                          <ChatAction
                                            text={Locale.Chat.Actions.Delete}
                                            icon={<DeleteIcon />}
                                            onClick={() =>
                                              onDelete(message.id ?? i)
                                            }
                                          />
                                        )}

                                      <ChatAction
                                        text={Locale.Chat.Actions.Copy}
                                        icon={<CopyIcon />}
                                        onClick={() =>
                                          copyToClipboard(
                                            getMessageTextContent(message),
                                          )
                                        }
                                      />
                                      {message.role !== "system" && (
                                        <ChatAction
                                          text={Locale.Chat.Actions.Debug}
                                          icon={<EyeIcon />}
                                          onClick={() =>
                                            setDebugMessage(message)
                                          }
                                        />
                                      )}
                                      {config.ttsConfig.enable &&
                                        message.role !== "system" &&
                                        message.id === regeneratableId && (
                                          <ChatAction
                                            text={
                                              speechStatus
                                                ? Locale.Chat.Actions.StopSpeech
                                                : Locale.Chat.Actions.Speech
                                            }
                                            icon={
                                              speechStatus ? (
                                                <SpeakStopIcon />
                                              ) : (
                                                <SpeakIcon />
                                              )
                                            }
                                            onClick={() =>
                                              openaiSpeech(
                                                getMessageTextContent(message),
                                              )
                                            }
                                          />
                                        )}

                                      {/* 这条回复是否生成完成（取消勾选后出现「继续生成」） */}
                                      {message.role === "assistant" &&
                                        message.id === regeneratableId && (
                                          <label
                                            className={
                                              styles["chat-message-complete"]
                                            }
                                            title={
                                              Locale.Chat.EditMessage.Complete
                                                .Hint
                                            }
                                          >
                                            <input
                                              type="checkbox"
                                              aria-label={
                                                Locale.Chat.EditMessage.Complete
                                                  .Label
                                              }
                                              checked={
                                                message.isComplete !== false
                                              }
                                              onChange={(e) => {
                                                const checked =
                                                  e.currentTarget.checked;
                                                chatStore.updateTargetSession(
                                                  session,
                                                  (session) => {
                                                    const m =
                                                      session.messages.find(
                                                        (m) =>
                                                          m.id === message.id,
                                                      );
                                                    if (!m) return;
                                                    m.isComplete = checked;
                                                    session.messages =
                                                      session.messages.concat();
                                                  },
                                                );
                                              }}
                                            />
                                            <span>
                                              {
                                                Locale.Chat.EditMessage.Complete
                                                  .Short
                                              }
                                            </span>
                                          </label>
                                        )}
                                    </>
                                  )}
                                </div>
                              </div>
                            )}
                          </div>
                          {message?.tools?.length == 0 && showTyping && (
                            <div className={styles["chat-message-status"]}>
                              {Locale.Chat.Typing}
                            </div>
                          )}
                          {/*@ts-ignore*/}
                          {message?.tools?.length > 0 && (
                            <div className={styles["chat-message-tools"]}>
                              {message?.tools?.map((tool) => (
                                <div
                                  key={tool.id}
                                  title={tool?.errorMsg}
                                  className={styles["chat-message-tool"]}
                                >
                                  {tool.isError === false ? (
                                    <ConfirmIcon />
                                  ) : tool.isError === true ? (
                                    <CloseIcon />
                                  ) : (
                                    <LoadingButtonIcon />
                                  )}
                                  <span>{tool?.function?.name}</span>
                                </div>
                              ))}
                            </div>
                          )}
                          <div className={styles["chat-message-item"]}>
                            <Markdown
                              key={message.streaming ? "loading" : "done"}
                              content={getMessageTextContent(message)}
                              loading={
                                (message.preview || message.streaming) &&
                                message.content.length === 0 &&
                                !isUser
                              }
                              //   onContextMenu={(e) => onRightClick(e, message)} // hard to use
                              fontSize={fontSize}
                              fontFamily={fontFamily}
                              parentRef={scrollRef}
                              defaultShow={i >= messages.length - 6}
                            />
                            {messageImages.length == 1 && (
                              <img
                                className={styles["chat-message-item-image"]}
                                src={messageImages[0]}
                                alt=""
                                onClick={() =>
                                  setPreviewImage(messageImages[0])
                                }
                              />
                            )}
                            {messageImages.length > 1 && (
                              <div
                                className={styles["chat-message-item-images"]}
                                style={
                                  {
                                    "--image-count": messageImages.length,
                                  } as React.CSSProperties
                                }
                              >
                                {messageImages.map((image, index) => {
                                  return (
                                    <img
                                      className={
                                        styles["chat-message-item-image-multi"]
                                      }
                                      key={index}
                                      src={image}
                                      alt=""
                                      onClick={() => setPreviewImage(image)}
                                    />
                                  );
                                })}
                              </div>
                            )}
                            {/* 文件附件卡片：用户消息上可以直接删除（同时删云端文件） */}
                            <MessageAttachments
                              attachments={message.attachments}
                              onDelete={
                                isUser
                                  ? (id) => {
                                      void removeMessageAttachment(message, id);
                                    }
                                  : undefined
                              }
                            />
                            {/* 知识库引用标记：只在最新一条引用过知识库的消息上显示 */}
                            {message.id === lastKnowledgeMessageId &&
                              message.retrieval &&
                              message.retrieval.sections.length > 0 && (
                                <KnowledgeBadge
                                  sections={message.retrieval.sections}
                                  tokens={message.retrieval.tokens}
                                  pinnedIds={session.knowledge?.sectionIds}
                                />
                              )}
                          </div>
                          {message?.audio_url && (
                            <div className={styles["chat-message-audio"]}>
                              <audio src={message.audio_url} controls />
                            </div>
                          )}

                          {!isContext && !showTyping && (
                            <MessageVariantSwitcher
                              session={session}
                              message={message}
                              onRegenerate={
                                isUser ||
                                message.role === "system" ||
                                message.id !== regeneratableId ||
                                !showActions
                                  ? undefined
                                  : () => onRetry(message)
                              }
                            />
                          )}

                          <div className={styles["chat-message-action-date"]}>
                            {isContext
                              ? Locale.Chat.IsContext
                              : message.date.toLocaleString()}
                          </div>
                        </div>
                      </div>
                      {shouldShowClearContextDivider && <ClearContextDivider />}
                    </Fragment>
                  );
                })}
            </div>
            {!hitBottom && (
              <div className={styles["chat-scroll-to-bottom"]}>
                <button
                  type="button"
                  className={styles["chat-scroll-to-bottom-button"]}
                  aria-label={Locale.Chat.InputActions.ToBottom}
                  title={Locale.Chat.InputActions.ToBottom}
                  onClick={scrollToBottom}
                >
                  <BottomIcon />
                </button>
              </div>
            )}
            <div className={styles["chat-input-panel"]}>
              <PromptHints
                prompts={promptHints}
                onPromptSelect={onPromptSelect}
              />

              {/* 已上传的文件附件：可逐个删除（会同时删云端文件） */}
              <AttachmentChips
                items={attachFiles}
                onRemove={(id) => {
                  void removeAttachFile(id);
                }}
                statusOf={(id) => attachStatus[id]}
              />

              <ChatActions
                uploadImage={uploadImage}
                uploadFile={() => fileInputRef.current?.click()}
                setAttachImages={setAttachImages}
                setUploading={setUploading}
                showPromptModal={() => setShowPromptModal(true)}
                uploading={uploading}
                showPromptHints={() => {
                  // Click again to close
                  if (promptHints.length > 0) {
                    setPromptHints([]);
                    return;
                  }

                  inputRef.current?.focus();
                  applyUserInput("/");
                  onSearch("");
                }}
                setShowShortcutKeyModal={setShowShortcutKeyModal}
                setUserInput={setUserInput}
                setShowChatSidePanel={setShowChatSidePanel}
              />
              {/* 任意文件（文档 / 文本 / 表格）；图片走上面的按钮 */}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={ACCEPT_FILE}
                style={{ display: "none" }}
                onChange={(e) => {
                  const picked = Array.from(e.currentTarget.files ?? []);
                  e.currentTarget.value = "";
                  void uploadAttachFiles(picked);
                }}
              />
              <label
                className={clsx(styles["chat-input-panel-inner"], {
                  [styles["chat-input-panel-inner-attach"]]:
                    attachImages.length !== 0,
                })}
                htmlFor="chat-input"
              >
                <textarea
                  id="chat-input"
                  ref={inputRef}
                  className={styles["chat-input"]}
                  placeholder={Locale.Chat.Input(submitKey)}
                  onInput={(e) => {
                    // 记一笔：失焦期间只要来过 input 事件，就不是“被静默吞掉”
                    inputEventsWhileAwayRef.current += 1;
                    onInput(e.currentTarget.value);
                  }}
                  onFocus={handleInputFocus}
                  onBlur={handleInputBlur}
                  defaultValue={userInput}
                  onKeyDown={onInputKeyDown}
                  /*
                   * 这里原来挂了 onFocus / onClick = scrollToBottom：
                   * 只要把光标点进输入框，就会强制把对话拉回最新一条，
                   * 正在往上翻历史的时候特别烦（移动端键盘一弹出更明显）。
                   * 现在聚焦、点击都不再改变滚动位置；需要回到底部时用
                   * 右下角的按钮，发送消息时也照旧会自动滚到最新。
                   */
                  onPaste={handlePaste}
                  rows={inputRows}
                  autoFocus={autoFocus}
                  style={{
                    fontSize: config.fontSize,
                    fontFamily: config.fontFamily,
                  }}
                />
                {attachImages.length != 0 && (
                  <div className={styles["attach-images"]}>
                    {attachImages.map((image, index) => {
                      return (
                        <div
                          key={index}
                          className={styles["attach-image"]}
                          style={{ backgroundImage: `url("${image}")` }}
                        >
                          <div className={styles["attach-image-mask"]}>
                            <DeleteImageButton
                              deleteImage={() => {
                                setAttachImages(
                                  attachImages.filter((_, i) => i !== index),
                                );
                              }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                {isGenerating ? (
                  <button
                    type="button"
                    className={clsx(
                      styles["chat-input-send"],
                      styles["chat-input-send-stop"],
                    )}
                    aria-label={Locale.Chat.Actions.Stop}
                    title={Locale.Chat.Actions.Stop}
                    onClick={onStopAll}
                  >
                    <StopIcon />
                  </button>
                ) : (
                  <button
                    type="button"
                    className={styles["chat-input-send"]}
                    aria-label={Locale.Chat.Send}
                    title={Locale.Chat.Send}
                    onClick={() => doSubmit(userInput)}
                  >
                    <SendWhiteIcon />
                  </button>
                )}
              </label>
            </div>
          </div>
          <div
            className={clsx(styles["chat-side-panel"], {
              [styles["mobile"]]: isMobileScreen,
              [styles["chat-side-panel-show"]]: showChatSidePanel,
            })}
          >
            {showChatSidePanel && (
              <RealtimeChat
                onClose={() => {
                  setShowChatSidePanel(false);
                }}
                onStartVoice={async () => {
                  console.log("start voice");
                }}
              />
            )}
          </div>
        </div>
      </div>
      {showExport && (
        <ExportMessageModal onClose={() => setShowExport(false)} />
      )}

      {isEditingMessage && (
        <EditMessageModal
          onClose={() => {
            setIsEditingMessage(false);
          }}
        />
      )}

      {showShortcutKeyModal && (
        <ShortcutKeyModal onClose={() => setShowShortcutKeyModal(false)} />
      )}

      {debugMessage && (
        <MessageDebugModal
          message={debugMessage}
          onClose={() => setDebugMessage(null)}
        />
      )}

      {previewImage && (
        <div
          className={styles["chat-image-preview-mask"]}
          onClick={() => setPreviewImage(null)}
        >
          <img
            className={styles["chat-image-preview-image"]}
            src={previewImage}
            alt=""
          />
        </div>
      )}
    </>
  );
}

export function Chat() {
  const chatStore = useChatStore();
  const session = chatStore.currentSession();
  return <_Chat key={session.id}></_Chat>;
}
