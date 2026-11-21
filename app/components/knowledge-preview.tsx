import React, { useMemo, useState } from "react";

import Locale from "../locales";
import { IconButton } from "./button";
import { Modal } from "./ui-lib";
import ConfirmIcon from "../icons/confirm.svg";
import CancelIcon from "../icons/cancel.svg";
import { createPortalLayer } from "../utils/portal";
import type { KnowledgeResult } from "../store/knowledge";

/**
 * 发送前的知识库预览（调试模式）。
 *
 * 开启后每次发送都会先把「这次要注入的知识库内容」摆出来：
 * 确认 → 继续发送请求；取消 → 什么都不发（输入框内容保留）。
 */
export function KnowledgePreviewDialog(props: {
  result: KnowledgeResult;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { result } = props;
  const totalChars = useMemo(
    () => result.hits.reduce((sum, hit) => sum + hit.text.length, 0),
    [result],
  );
  const debug = result.debug;

  /** 空结果时给出具体原因：库是空的？还是这次没匹配到？ */
  const emptyReason = useMemo(() => {
    if (result.hits.length > 0) return "";
    if (debug?.reason === "no-docs") return Locale.Chat.Knowledge.EmptyNoDocs;
    if (debug?.reason === "empty-query")
      return Locale.Chat.Knowledge.EmptyQuery;
    if (debug?.reason === "no-match") {
      const tokens = (debug.queryTokens ?? []).slice(0, 12).join(" / ");
      return Locale.Chat.Knowledge.EmptyNoMatch(
        debug.docs,
        debug.chunks,
        tokens || "(无)",
      );
    }
    return Locale.Chat.Knowledge.PreviewEmpty;
  }, [result, debug]);

  return (
    <div className="modal-mask">
      <Modal
        title={Locale.Chat.Knowledge.PreviewTitle}
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
            text={Locale.Chat.Knowledge.PreviewConfirm}
            icon={<ConfirmIcon />}
            onClick={props.onConfirm}
          />,
        ]}
      >
        <div className="knowledge-preview">
          <div className="knowledge-preview-hint">
            {/* 库的规模一直显示：一眼就能看出“是不是根本没导入” */}
            <div className="knowledge-preview-stats">
              {debug
                ? Locale.Chat.Knowledge.PreviewStats(debug.docs, debug.chunks)
                : null}
            </div>
            {result.hits.length === 0 ? (
              <div className="knowledge-preview-empty">{emptyReason}</div>
            ) : (
              <div>
                {Locale.Chat.Knowledge.PreviewHint(
                  result.hits.length,
                  result.tokens,
                )}
                <span className="knowledge-preview-chars">
                  {" "}
                  · {totalChars} 字符
                </span>
              </div>
            )}
          </div>

          {result.hits.map((hit, index) => (
            <details
              key={hit.chunk.id}
              className="knowledge-preview-item"
              open={index === 0}
            >
              <summary>
                <span className="knowledge-preview-path">
                  [{index + 1}] {hit.chunk.headingPath || hit.chunk.heading}
                </span>
                <span className="knowledge-preview-meta">
                  {hit.chunk.docName} · {hit.chunk.chars} 字 · ≈{hit.estTokens}{" "}
                  token
                  {hit.truncated ? " · 已截断" : ""}
                </span>
              </summary>
              <pre className="knowledge-preview-text">{hit.text}</pre>
            </details>
          ))}
        </div>
      </Modal>
    </div>
  );
}

/**
 * 命令式调用：弹出预览，返回是否确认发送。
 */
export function showKnowledgePreview(
  result: KnowledgeResult,
): Promise<boolean> {
  const layer = createPortalLayer();
  return new Promise<boolean>((resolve) => {
    const finish = (ok: boolean) => {
      layer.destroy();
      resolve(ok);
    };
    layer.root.render(
      <KnowledgePreviewDialog
        result={result}
        onConfirm={() => finish(true)}
        onCancel={() => finish(false)}
      />,
    );
  });
}
