import React, { useState } from "react";
import Locale from "../locales";
import { Modal } from "./ui-lib";
import { IconButton } from "./button";
import type { ConflictChoice, SyncConflict } from "../utils/sync-merge";
import styles from "./sync-conflict.module.scss";

/**
 * 冲突选择：同一个会话在本地和云端都被改过，让用户决定留哪一份。
 * 只展示「最后一条 user / assistant」，看得懂是哪个对话就够了。
 */
export function SyncConflictModal(props: {
  conflicts: SyncConflict[];
  onResolve: (choices: Record<string, ConflictChoice>) => void;
  onCancel: () => void;
}) {
  const [choices, setChoices] = useState<Record<string, ConflictChoice>>({});

  const setAll = (choice: ConflictChoice) => {
    const next: Record<string, ConflictChoice> = {};
    props.conflicts.forEach((c) => (next[c.id] = choice));
    setChoices(next);
  };

  const choiceOf = (id: string): ConflictChoice => choices[id] ?? "local";

  return (
    <div className="modal-mask">
      <Modal
        title={Locale.Settings.Sync.Conflict.Title(props.conflicts.length)}
        actions={[
          <IconButton
            key="cancel"
            text={Locale.UI.Cancel}
            onClick={() => props.onCancel()}
          />,
          <IconButton
            key="local"
            text={Locale.Settings.Sync.Conflict.AllLocal}
            onClick={() => setAll("local")}
          />,
          <IconButton
            key="remote"
            text={Locale.Settings.Sync.Conflict.AllRemote}
            onClick={() => setAll("remote")}
          />,
          <IconButton
            key="ok"
            type="primary"
            text={Locale.Settings.Sync.Conflict.Confirm}
            onClick={() => props.onResolve(choices)}
          />,
        ]}
      >
        <div className={styles["conflict-tip"]}>
          {Locale.Settings.Sync.Conflict.Tip}
        </div>

        <div className={styles["conflict-list"]}>
          {props.conflicts.map((conflict) => (
            <div key={conflict.id} className={styles["conflict-item"]}>
              <div className={styles["conflict-topic"]}>
                {conflict.local.topic || conflict.remote.topic || conflict.id}
              </div>

              <div className={styles["conflict-sides"]}>
                {(["local", "remote"] as const).map((side) => {
                  const brief =
                    side === "local" ? conflict.local : conflict.remote;
                  const active = choiceOf(conflict.id) === side;
                  return (
                    <button
                      key={side}
                      type="button"
                      className={`${styles["conflict-side"]} ${
                        active ? styles["active"] : ""
                      }`}
                      onClick={() =>
                        setChoices((prev) => ({ ...prev, [conflict.id]: side }))
                      }
                    >
                      <div className={styles["conflict-side-title"]}>
                        {side === "local"
                          ? Locale.Settings.Sync.Conflict.Local
                          : Locale.Settings.Sync.Conflict.Remote}
                        <span className={styles["conflict-side-meta"]}>
                          {Locale.Settings.Sync.Conflict.MessageCount(
                            brief.messageCount,
                          )}
                        </span>
                      </div>
                      <div className={styles["conflict-role"]}>User</div>
                      <div className={styles["conflict-text"]}>
                        {brief.lastUser || "—"}
                      </div>
                      <div className={styles["conflict-role"]}>Assistant</div>
                      <div className={styles["conflict-text"]}>
                        {brief.lastAssistant || "—"}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </Modal>
    </div>
  );
}
