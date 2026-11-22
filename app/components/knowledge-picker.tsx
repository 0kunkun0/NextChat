import React, { useMemo, useState } from "react";

import Locale from "../locales";
import { IconButton } from "./button";
import { Modal } from "./ui-lib";
import ConfirmIcon from "../icons/confirm.svg";
import CancelIcon from "../icons/cancel.svg";
import { createPortalLayer } from "../utils/portal";
import type { KnowledgeChunk } from "../utils/knowledge/retrieval";
import { highlightParts, previewOf } from "../utils/knowledge/preview";

/**
 * 「选择本次使用的知识库片段」弹窗。
 *
 * 为什么需要手动选：文档标题经常是「概述」「常见用法」这种泛化标题，
 * 光看标题选不准，所以每行都带上正文预览；也支持按关键字 / 文档名过滤。
 */

const PAGE_SIZE = 40;

type PickerProps = {
  sections: KnowledgeChunk[];
  selected: string[];
  onCancel: () => void;
  onConfirm: (ids: string[]) => void;
};

export function KnowledgeSectionPicker(props: PickerProps) {
  const { sections } = props;
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(props.selected),
  );
  const [keyword, setKeyword] = useState("");
  const [docFilter, setDocFilter] = useState("");
  const [visible, setVisible] = useState(PAGE_SIZE);

  const docs = useMemo(() => {
    const names = new Map<string, number>();
    for (const section of sections) {
      names.set(section.docName, (names.get(section.docName) ?? 0) + 1);
    }
    return [...names.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [sections]);

  const filtered = useMemo(() => {
    const needle = keyword.trim().toLowerCase();
    return sections.filter((section) => {
      if (docFilter && section.docName !== docFilter) return false;
      if (!needle) return true;
      return (
        section.headingPath.toLowerCase().includes(needle) ||
        section.docName.toLowerCase().includes(needle) ||
        section.text.toLowerCase().includes(needle)
      );
    });
  }, [sections, keyword, docFilter]);

  const shown = filtered.slice(0, visible);

  /** 已选片段的 token 估算：选多了心里有数 */
  const selectedTokens = useMemo(() => {
    if (selected.size === 0) return 0;
    return sections.reduce(
      (sum, section) =>
        selected.has(section.id) ? sum + section.estTokens : sum,
      0,
    );
  }, [sections, selected]);

  const toggle = (id: string, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  return (
    <div className="modal-mask">
      <Modal
        title={Locale.Chat.Knowledge.PickTitle}
        onClose={props.onCancel}
        defaultMax
        actions={[
          <IconButton
            key="cancel"
            text={Locale.Chat.Knowledge.PreviewCancel}
            icon={<CancelIcon />}
            onClick={props.onCancel}
          />,
          <IconButton
            key="ok"
            type="primary"
            text={Locale.Chat.Knowledge.PickConfirm(selected.size)}
            icon={<ConfirmIcon />}
            onClick={() => props.onConfirm([...selected])}
          />,
        ]}
      >
        <div className="knowledge-picker">
          <div className="knowledge-picker-hint">
            {Locale.Chat.Knowledge.PickHint}
          </div>

          <div className="knowledge-picker-filters">
            <input
              className="knowledge-picker-search"
              value={keyword}
              placeholder={Locale.Chat.Knowledge.PickSearchPlaceholder}
              onChange={(e) => {
                setKeyword(e.currentTarget.value);
                setVisible(PAGE_SIZE);
              }}
            />
            <select
              className="knowledge-picker-doc"
              value={docFilter}
              onChange={(e) => {
                setDocFilter(e.currentTarget.value);
                setVisible(PAGE_SIZE);
              }}
            >
              <option value="">
                {Locale.Chat.Knowledge.PickAllDocs(docs.length)}
              </option>
              {docs.map(([name, count]) => (
                <option key={name} value={name}>
                  {name}（{count}）
                </option>
              ))}
            </select>
          </div>

          <div className="knowledge-picker-actions">
            <span className="knowledge-picker-count">
              {Locale.Chat.Knowledge.PickSelected(
                selected.size,
                sections.length,
              )}
              {selectedTokens > 0
                ? ` · ${Locale.Chat.Knowledge.PickTokens(selectedTokens)}`
                : ""}
            </span>
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="knowledge-picker-link"
            >
              {Locale.Chat.Knowledge.PickSelectNone}
            </button>
            <button
              type="button"
              onClick={() =>
                setSelected(new Set(filtered.slice(0, 500).map((s) => s.id)))
              }
              className="knowledge-picker-link"
            >
              {Locale.Chat.Knowledge.PickSelectFiltered(filtered.length)}
            </button>
          </div>

          <div className="knowledge-picker-list">
            {shown.map((section) => {
              const checked = selected.has(section.id);
              return (
                <label
                  key={section.id}
                  className={`knowledge-picker-row${
                    checked ? " is-checked" : ""
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) =>
                      toggle(section.id, e.currentTarget.checked)
                    }
                  />
                  <span className="knowledge-picker-body">
                    <span className="knowledge-picker-title">
                      <Highlight
                        text={section.headingPath || section.heading}
                        keyword={keyword}
                      />
                    </span>
                    <span className="knowledge-picker-meta">
                      {section.docName} · {section.chars} 字
                      {section.codeBlocks > 0
                        ? ` · ${section.codeBlocks} 个代码块`
                        : ""}
                    </span>
                    <span className="knowledge-picker-preview">
                      {/* 预览从命中处截取，并把关键字标出来 */}
                      <Highlight
                        text={previewOf(section, keyword)}
                        keyword={keyword}
                      />
                    </span>
                  </span>
                </label>
              );
            })}

            {shown.length === 0 && (
              <div className="knowledge-picker-empty">
                {Locale.Chat.Knowledge.PickNoMatch}
              </div>
            )}

            {filtered.length > shown.length && (
              <button
                type="button"
                className="knowledge-picker-link knowledge-picker-more"
                onClick={() => setVisible((n) => n + PAGE_SIZE)}
              >
                {Locale.Chat.Knowledge.PickMore(filtered.length - shown.length)}
              </button>
            )}
          </div>
        </div>
      </Modal>
    </div>
  );
}

/** 把关键字命中处渲染成 <mark> */
function Highlight(props: { text: string; keyword: string }) {
  const parts = highlightParts(props.text, props.keyword);
  return (
    <>
      {parts.map((part, index) =>
        part.hit ? (
          <mark key={index} className="knowledge-picker-hit">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}
/** 命令式调用：返回选中的片段 id（取消返回 null） */
export function showKnowledgeSectionPicker(options: {
  sections: KnowledgeChunk[];
  selected: string[];
}): Promise<string[] | null> {
  const layer = createPortalLayer();
  return new Promise<string[] | null>((resolve) => {
    const finish = (value: string[] | null) => {
      layer.destroy();
      resolve(value);
    };
    layer.root.render(
      <KnowledgeSectionPicker
        sections={options.sections}
        selected={options.selected}
        onCancel={() => finish(null)}
        onConfirm={(ids) => finish(ids)}
      />,
    );
  });
}
