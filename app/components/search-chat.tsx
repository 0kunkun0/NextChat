import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ErrorBoundary } from "./error";
import styles from "./mask.module.scss";
import { useNavigate } from "react-router-dom";
import { IconButton } from "./button";
import CloseIcon from "../icons/close.svg";
import EyeIcon from "../icons/eye.svg";
import Locale from "../locales";
import { Path } from "../constant";

import { useChatStore } from "../store";
import { useScrollTargetStore } from "../store/scroll-target";
import {
  countMatches,
  searchSessions,
  type ChatSearchResult,
} from "../utils/search-chat";
import { highlightParts } from "../utils/text-highlight";

/**
 * 搜索聊天记录。
 *
 * 修的两个问题：
 *   1. 点结果只是切了会话，**不会跳到命中的那条消息**；
 *   2. 一个会话里命中多处时，界面只截了前 70 字，看起来只有一个关键词。
 *
 * 现在按「会话 → 命中列表」展示，每条命中都能点，点击后：
 *   选会话 → 把 messageId 交给聊天页 → 聊天页展开窗口并滚到那条消息。
 */
export function SearchChatPage() {
  const navigate = useNavigate();

  const chatStore = useChatStore();
  const sessions = chatStore.sessions;
  const selectSession = chatStore.selectSession;
  const requestScrollTo = useScrollTargetStore((state) => state.request);

  const [keyword, setKeyword] = useState("");
  const [results, setResults] = useState<ChatSearchResult[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const searchInputRef = useRef<HTMLInputElement>(null);

  const runSearch = useCallback((text: string) => {
    // 每次都取最新 sessions，避免 effect 闭包里拿到旧快照
    const current = useChatStore.getState().sessions;
    setResults(searchSessions(current, text));
  }, []);

  // 输入防抖：400ms 内没有新输入才真正检索（原来是 1s 轮询）
  useEffect(() => {
    const timer = setTimeout(() => runSearch(keyword), 400);
    return () => clearTimeout(timer);
  }, [keyword, runSearch, sessions]);

  const totalMatches = useMemo(() => countMatches(results), [results]);

  /**
   * 跳到某条消息：先切会话，再把目标交给聊天页。
   *
   * 这里**按 session.id 现查下标**，不用检索时记下的 sessionIndex：
   * 会话是按 lastUpdate 排序的，搜索结果放一会儿再点，下标可能已经指向别的会话了。
   */
  const jumpToMessage = useCallback(
    (sessionId: string, messageId: string) => {
      if (!messageId) return;
      const index = useChatStore
        .getState()
        .sessions.findIndex((session) => session.id === sessionId);
      if (index < 0) return;

      requestScrollTo(messageId);
      selectSession(index);
      navigate(Path.Chat);
    },
    [navigate, requestScrollTo, selectSession],
  );

  return (
    <ErrorBoundary>
      <div className={styles["mask-page"]}>
        {/* header */}
        <div className="window-header">
          <div className="window-header-title">
            <div className="window-header-main-title">
              {Locale.SearchChat.Page.Title}
            </div>
            <div className="window-header-submai-title">
              {Locale.SearchChat.Page.SubTitleWithMatches(
                results.length,
                totalMatches,
              )}
            </div>
          </div>

          <div className="window-actions">
            <div className="window-action-button">
              <IconButton
                icon={<CloseIcon />}
                bordered
                onClick={() => navigate(-1)}
              />
            </div>
          </div>
        </div>

        <div className={styles["mask-page-body"]}>
          <div className={styles["mask-filter"]}>
            <input
              type="text"
              className={styles["search-bar"]}
              placeholder={Locale.SearchChat.Page.Search}
              autoFocus
              ref={searchInputRef}
              value={keyword}
              onChange={(e) => setKeyword(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  runSearch(e.currentTarget.value);
                }
              }}
            />
          </div>

          <div>
            {results.map((result) => {
              const isExpanded = expanded[result.sessionId] === true;
              const visible = isExpanded
                ? result.matches
                : result.matches.slice(0, 3);

              return (
                <div
                  className={styles["mask-item"]}
                  key={result.sessionId}
                  style={{ cursor: "pointer" }}
                >
                  {/** 会话标题 + 命中数 */}
                  <div className={styles["mask-header"]}>
                    <div className={styles["mask-title"]}>
                      <div className={styles["mask-name"]}>
                        {result.topic || "(无标题)"}
                        <span className="search-chat-count">
                          {" "}
                          {Locale.SearchChat.Item.MatchCount(
                            result.matches.length,
                          )}
                        </span>
                      </div>
                    </div>
                    <div className={styles["mask-actions"]}>
                      <IconButton
                        icon={<EyeIcon />}
                        text={Locale.SearchChat.Item.View}
                        onClick={() =>
                          jumpToMessage(
                            result.sessionId,
                            result.matches[0]?.messageId ?? "",
                          )
                        }
                      />
                    </div>
                  </div>

                  {/** 每一处命中单独一行，点击直达 */}
                  <div className="search-chat-matches">
                    {visible.map((match, index) => (
                      <button
                        type="button"
                        key={`${match.messageId}-${match.matchIndex}-${index}`}
                        className="search-chat-match"
                        title={Locale.SearchChat.Item.JumpToMessage}
                        onClick={() =>
                          jumpToMessage(result.sessionId, match.messageId)
                        }
                      >
                        <span className="search-chat-role">
                          {match.role === "user"
                            ? Locale.SearchChat.Item.RoleUser
                            : Locale.SearchChat.Item.RoleAssistant}
                        </span>
                        <span className="search-chat-snippet">
                          {highlightParts(match.snippet, keyword).map(
                            (part, i) =>
                              part.hit ? (
                                <mark key={i} className="search-chat-hit">
                                  {part.text}
                                </mark>
                              ) : (
                                <span key={i}>{part.text}</span>
                              ),
                          )}
                        </span>
                      </button>
                    ))}

                    {result.matches.length > visible.length && (
                      <button
                        type="button"
                        className="search-chat-more"
                        onClick={() =>
                          setExpanded((prev) => ({
                            ...prev,
                            [result.sessionId]: true,
                          }))
                        }
                      >
                        {Locale.SearchChat.Item.ShowMore(
                          result.matches.length - visible.length,
                        )}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}

            {keyword.trim().length > 0 && results.length === 0 && (
              <div className="search-chat-empty">
                {Locale.SearchChat.Page.NoResult}
              </div>
            )}
          </div>
        </div>
      </div>
    </ErrorBoundary>
  );
}
