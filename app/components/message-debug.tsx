import { useMemo } from "react";
import CopyIcon from "../icons/copy.svg";
import { ChatMessage } from "../store";
import { copyToClipboard, getMessageTextContent } from "../utils";
import { getMarkdownInput } from "../utils/markdown";
import Locale from "../locales";
import { IconButton } from "./button";
import { Modal } from "./ui-lib";
import styles from "./message-debug.module.scss";

/**
 * 消息原始数据调试窗口。
 * 用来对照「存储里的原文」和「交给 Markdown 渲染器的字符串」，
 * 判断换行/空行到底是在哪一层丢的。
 */
export function MessageDebugModal(props: {
  message: ChatMessage;
  onClose: () => void;
}) {
  const rawContent = getMessageTextContent(props.message);
  const markdownInput = useMemo(
    () => getMarkdownInput(rawContent),
    [rawContent],
  );
  const rawJson = useMemo(
    () => JSON.stringify(props.message, null, 2),
    [props.message],
  );

  const newlineCount = (rawContent.match(/\n/g) ?? []).length;
  const blankLineCount = (rawContent.match(/\n[ \t\u3000\u00a0]*\n/g) ?? [])
    .length;
  const preprocessed = markdownInput !== rawContent;

  // 让换行可见：每个 \n 后面补一个 ⏎ 标记
  const withVisibleNewlines = (text: string) => text.replace(/\n/g, "⏎\n");

  return (
    <div className="modal-mask">
      <Modal
        title={Locale.Chat.Debug.Title}
        onClose={props.onClose}
        defaultMax
        actions={[
          <IconButton
            key="copy-markdown"
            text={Locale.Chat.Debug.CopyMarkdown}
            icon={<CopyIcon />}
            bordered
            onClick={() => copyToClipboard(markdownInput)}
          />,
          <IconButton
            key="copy-json"
            text={Locale.Chat.Debug.CopyJson}
            icon={<CopyIcon />}
            bordered
            onClick={() => copyToClipboard(rawJson)}
          />,
        ]}
      >
        <div className={styles["message-debug"]}>
          <div className={styles["summary"]}>
            {Locale.Chat.Debug.Summary(
              rawContent.length,
              newlineCount,
              blankLineCount,
            )}
          </div>
          <div
            className={styles["preprocess"]}
            data-changed={preprocessed ? "true" : "false"}
          >
            {preprocessed
              ? Locale.Chat.Debug.PreprocessChanged
              : Locale.Chat.Debug.PreprocessUnchanged}
          </div>

          <div className={styles["section-title"]}>
            {Locale.Chat.Debug.MarkdownInput}
          </div>
          <pre className={styles["code"]}>
            {withVisibleNewlines(markdownInput)}
          </pre>

          <div className={styles["section-title"]}>
            {Locale.Chat.Debug.RawJson}
          </div>
          <pre className={styles["code"]}>{rawJson}</pre>
        </div>
      </Modal>
    </div>
  );
}
