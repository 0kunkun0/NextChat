import React, { useMemo, useState } from "react";

import Locale from "../locales";
import { Modal } from "./ui-lib";
import { IconButton } from "./button";
import ConfirmIcon from "../icons/confirm.svg";
import CancelIcon from "../icons/cancel.svg";
import type { ImportedConversation } from "../utils/deepseek-import";
import {
  isAllSelected,
  selectAll,
  toggleSelected,
} from "../utils/import-selection";

/**
 * 选择要导入哪些会话。
 *
 * 列表顺序已经是「置顶优先 + 更新时间倒序」（由 parseDeepseekExport 排好），
 * 默认全部勾选；顶部还有一个「全选 / 取消全选」。
 */
export function ImportSessionPicker(props: {
  candidates: ImportedConversation[];
  onCancel: () => void;
  onImport: (picked: ImportedConversation[]) => void;
}) {
  const { candidates, onCancel, onImport } = props;
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(candidates.map((item) => item.exportId)),
  );

  const allSelected = isAllSelected(selected, candidates.length);

  const rows = useMemo(
    () =>
      candidates.map((item) => {
        const checked = selected.has(item.exportId);
        return (
          <label key={item.exportId} className="deepseek-import-row">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => {
                /**
                 * 必须先把 checked 取出来。
                 * React 在事件回调返回后会把 `currentTarget` 置空，而 setState 的
                 * updater 是稍后执行的 —— 在 updater 里读 e.currentTarget 会拿到
                 * null，报 "Cannot read properties of null (reading 'checked')"。
                 */
                const nextChecked = e.currentTarget.checked;
                setSelected((current) =>
                  toggleSelected(current, item.exportId, nextChecked),
                );
              }}
            />
            <span className="deepseek-import-title">
              {item.pinned && (
                <span className="deepseek-import-pin" aria-hidden="true">
                  📌
                </span>
              )}
              {item.title}
            </span>
            <span className="deepseek-import-meta">
              {item.messageCount} 条 ·{" "}
              {new Date(item.updatedAt).toLocaleDateString()}
            </span>
          </label>
        );
      }),
    [candidates, selected],
  );

  return (
    <div className="modal-mask">
      <Modal
        title={Locale.Settings.DeepseekImport.PickTitle(candidates.length)}
        onClose={onCancel}
        defaultMax
        actions={[
          <IconButton
            key="cancel"
            text={Locale.UI.Cancel}
            icon={<CancelIcon />}
            onClick={onCancel}
          />,
          <IconButton
            key="ok"
            type="primary"
            text={Locale.Settings.DeepseekImport.ImportSelected(selected.size)}
            icon={<ConfirmIcon />}
            onClick={() => {
              onImport(
                candidates.filter((item) => selected.has(item.exportId)),
              );
            }}
          />,
        ]}
      >
        <label className="deepseek-import-row deepseek-import-all">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={(e) => {
              const nextChecked = e.currentTarget.checked;
              setSelected(
                selectAll(
                  candidates.map((item) => item.exportId),
                  nextChecked,
                ),
              );
            }}
          />
          <span className="deepseek-import-title">
            {allSelected
              ? Locale.Settings.DeepseekImport.SelectNone
              : Locale.Settings.DeepseekImport.SelectAll}
          </span>
        </label>
        <div className="deepseek-import-list">{rows}</div>
      </Modal>
    </div>
  );
}
