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
            {result.hits.length === 0
              ? Locale.Chat.Knowledge.PreviewEmpty
              : Locale.Chat.Knowledge.PreviewHint(
                  result.hits.length,
                  result.tokens,
                )}
            {result.hits.length > 0 && (
              <span className="knowledge-preview-chars">
                {" "}
                · {totalChars} 字符
              </span>
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
