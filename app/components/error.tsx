"use client";

import React from "react";
import { IconButton } from "./button";
import GithubIcon from "../icons/github.svg";
import ResetIcon from "../icons/reload.svg";
import { ISSUE_URL } from "../constant";
import Locale from "../locales";
import { showConfirm } from "./ui-lib";
import { useSyncStore } from "../store/sync";
import { useChatStore } from "../store/chat";
import { clearServiceWorkerCache } from "../utils/pwa";

interface IErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  info: React.ErrorInfo | null;
  /** chunk 加载失败后正在自动刷新，先显示一个轻量的过渡界面 */
  reloading?: boolean;
}

/** 上一次因为 chunk 加载失败而自动刷新的时间 */
const CHUNK_RELOAD_KEY = "chunk-load-error-reloaded-at";
const CHUNK_RELOAD_COOLDOWN = 10_000;

/**
 * Next 的动态 import / 路由 chunk 加载失败。
 * 典型原因：部署换了新版本，页面（或 Service Worker 缓存的 HTML）还引用着旧的
 * chunk 文件名，这些文件在服务器上已经不存在了。
 */
function isChunkLoadError(error: Error | null) {
  if (!error) return false;
  const text = `${error.name} ${error.message}`;
  return /ChunkLoadError|Loading (CSS )?chunk [\w-]+ failed|Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(
    text,
  );
}

export class ErrorBoundary extends React.Component<any, IErrorBoundaryState> {
  constructor(props: any) {
    super(props);
    this.state = { hasError: false, error: null, info: null };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // chunk 加载失败通常是“本地还是旧版本”，刷新一次（并清掉 SW 缓存）
    // 就能恢复，不必把用户丢到满屏的错误页上
    if (isChunkLoadError(error) && this.shouldReloadForChunkError()) {
      this.markReloaded();
      // 先切到“正在刷新”的状态，避免 React 继续重试崩溃的子树
      this.setState({ hasError: true, error, info, reloading: true });
      clearServiceWorkerCache();
      return;
    }

    // Update state with error details
    this.setState({ hasError: true, error, info });
  }

  shouldReloadForChunkError() {
    try {
      const last = Number(sessionStorage.getItem(CHUNK_RELOAD_KEY) ?? 0);
      return Date.now() - last > CHUNK_RELOAD_COOLDOWN;
    } catch {
      return false;
    }
  }

  markReloaded() {
    try {
      sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()));
    } catch {
      // 隐私模式下 sessionStorage 可能不可用，忽略
    }
  }

  clearAndSaveData() {
    try {
      useSyncStore.getState().export();
    } finally {
      useChatStore.getState().clearAllData();
    }
  }

  render() {
    if (this.state.reloading) {
      // 正在自动刷新拿新版本：给个轻量提示，不要弹满屏错误框
      return (
        <div className="error">
          <h2>Updating…</h2>
          <pre>
            <code>检测到本地缓存与服务器版本不一致，正在刷新…</code>
          </pre>
        </div>
      );
    }

    if (this.state.hasError) {
      // Render error message
      return (
        <div className="error">
          <h2>Oops, something went wrong!</h2>
          <pre>
            <code>{this.state.error?.toString()}</code>
            <code>{this.state.info?.componentStack}</code>
          </pre>

          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <a href={ISSUE_URL} className="report">
              <IconButton
                text="Report This Error"
                icon={<GithubIcon />}
                bordered
              />
            </a>
            <IconButton
              icon={<ResetIcon />}
              text="Clear All Data"
              onClick={async () => {
                if (await showConfirm(Locale.Settings.Danger.Reset.Confirm)) {
                  this.clearAndSaveData();
                }
              }}
              bordered
            />
          </div>
        </div>
      );
    }
    // if no error occurred, render children
    return this.props.children;
  }
}
