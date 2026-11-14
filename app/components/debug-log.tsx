"use client";

import React, { useCallback, useEffect, useState } from "react";

import { Modal } from "./ui-lib";
import { IconButton } from "./button";
import ClearIcon from "../icons/clear.svg";
import ReloadIcon from "../icons/reload.svg";
import Locale from "../locales";

import {
  DebugLogEntry,
  clearLogs,
  getLogStats,
  loadLogs,
} from "../store/debug-log";

import styles from "./debug-log.module.scss";

const PAGE_SIZE = 200;

function formatTime(time: number) {
  const d = new Date(time);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(
    d.getSeconds(),
  )}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 调试日志查看器。
 *
 * 通过 dynamic import 懒加载，只有真的点开时才下载这部分代码，
 * 日志本身也是按需从 IndexedDB 里分块读取的。
 */
export function DebugLogModal(props: { onClose: () => void }) {
  const [entries, setEntries] = useState<DebugLogEntry[]>([]);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [stats, setStats] = useState({
    bytes: 0,
    entries: 0,
    chunks: 0,
    dropped: 0,
  });
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [{ entries }, nextStats] = await Promise.all([
        loadLogs(limit),
        getLogStats(),
      ]);
      setEntries(entries);
      setStats(nextStats);
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="modal-mask">
      <Modal
        title={Locale.Settings.DebugLog.Title}
        onClose={props.onClose}
        defaultMax={true}
        actions={[
          <IconButton
            key="refresh"
            icon={<ReloadIcon />}
            text={Locale.Settings.DebugLog.Refresh}
            onClick={() => void refresh()}
          />,
          <IconButton
            key="clear"
            icon={<ClearIcon />}
            text={Locale.Settings.DebugLog.Clear}
            onClick={async () => {
              await clearLogs();
              setLimit(PAGE_SIZE);
              await refresh();
            }}
          />,
        ]}
      >
        <div className={styles["debug-log"]}>
          <div className={styles["debug-log-stats"]}>
            {Locale.Settings.DebugLog.Stats(
              formatBytes(stats.bytes),
              stats.entries,
            )}
            {stats.dropped > 0 &&
              " " + Locale.Settings.DebugLog.Dropped(stats.dropped)}
          </div>

          <div className={styles["debug-log-list"]}>
            {entries.length === 0 && !loading && (
              <div className={styles["debug-log-empty"]}>
                {Locale.Settings.DebugLog.Empty}
              </div>
            )}
            {entries.map((entry) => (
              <div
                key={`${entry.seq}-${entry.time}`}
                className={styles["debug-log-row"]}
                data-level={entry.level}
              >
                <span className={styles["debug-log-time"]}>
                  {formatTime(entry.time)}
                </span>
                <span className={styles["debug-log-level"]}>{entry.level}</span>
                <span className={styles["debug-log-text"]}>{entry.text}</span>
              </div>
            ))}
          </div>

          {entries.length >= limit && (
            <div className={styles["debug-log-more"]}>
              <IconButton
                text={Locale.Settings.DebugLog.LoadMore}
                onClick={() => setLimit(limit + PAGE_SIZE)}
              />
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}
