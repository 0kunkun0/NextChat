import React, { useEffect, useRef } from "react";

import Locale from "../locales";
import { useKnowledgeStore } from "../store/knowledge";
import { useChatStore } from "../store/chat";
import {
  findAffectedSessions,
  formatAffectedTopics,
  stripDocReferences,
} from "../utils/knowledge/affected";
import { IconButton } from "./button";
import { List, ListItem, showConfirm, showToast } from "./ui-lib";
import AddIcon from "../icons/add.svg";
import DeleteIcon from "../icons/delete.svg";
import UploadIcon from "../icons/upload.svg";

/**
 * 知识库管理（弹窗内容）：导入 Markdown、查看统计、删除文档。
 *
 * 知识库存在本机 IndexedDB；如果开启了云同步，会作为额外 store 一起上传
 * （见 utils/knowledge/sync.ts）。
 */
export function KnowledgeSettingsSection() {
  const store = useKnowledgeStore();
  const chatStore = useChatStore();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    store.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const totalSections = store.docs.reduce((sum, doc) => sum + doc.chunks, 0);
  const totalChars = store.docs.reduce((sum, doc) => sum + doc.chars, 0);

  const handleFiles = async (files: File[]) => {
    if (files.length === 0) return;
    const { imported, chunks } = await store.importFiles(files);
    if (imported > 0) {
      showToast(Locale.Settings.Knowledge.Imported(imported, chunks));
    }
  };

  /**
   * 删除前先查「哪些对话引用过这份文档」，提示之后再删。
   *
   * 删完还要把那些对话里失效的引用清掉：否则消息上会留下指向不存在片段的
   * 标记，发送时也会白跑一次检索。
   */
  const handleRemoveDoc = async (docId: string, docName: string) => {
    const affected = findAffectedSessions(chatStore.sessions, [docId]);
    const confirmed = await showConfirm(
      affected.length > 0
        ? Locale.Settings.Knowledge.RemoveAffected(
            docName,
            affected.length,
            formatAffectedTopics(affected),
          )
        : Locale.Settings.Knowledge.RemoveConfirm(docName),
    );
    if (!confirmed) return;

    await store.remove(docId);
    if (affected.length > 0) {
      cleanReferences([docId]);
      showToast(Locale.Settings.Knowledge.CleanedReferences(affected.length));
    }
  };

  /** 清空知识库：同样先提示影响的对话，再删引用 */
  const handleClearAll = async () => {
    const docIds = store.docs.map((doc) => doc.id);
    const affected = findAffectedSessions(chatStore.sessions, docIds);
    const confirmed = await showConfirm(
      affected.length > 0
        ? Locale.Settings.Knowledge.ClearAllAffected(
            affected.length,
            formatAffectedTopics(affected),
          )
        : Locale.Settings.Knowledge.ClearAllConfirm,
    );
    if (!confirmed) return;

    await store.clear();
    if (affected.length > 0) {
      cleanReferences(docIds);
    }
  };

  /** 把会话里属于这些文档的引用 / 勾选片段清掉 */
  const cleanReferences = (docIds: string[]) => {
    chatStore.update((state) => {
      for (const session of state.sessions) {
        const result = stripDocReferences(session, docIds);
        if (result.removedSections > 0 || result.removedPinned > 0) {
          // 替换数组引用，让消息列表和标记重新渲染
          session.messages = session.messages.concat();
        }
      }
    });
  };

  return (
    <List>
      <ListItem
        title={
          store.docs.length === 0
            ? Locale.Settings.Knowledge.Empty
            : Locale.Settings.Knowledge.Stats(
                store.docs.length,
                totalSections,
                totalChars,
              )
        }
        subTitle={Locale.Settings.Knowledge.LocalOnly}
      >
        <div style={{ display: "flex", gap: 8 }}>
          <IconButton
            icon={<UploadIcon />}
            text={
              store.importing
                ? Locale.Settings.Knowledge.Importing
                : Locale.Settings.Knowledge.Import
            }
            disabled={store.importing}
            onClick={() => inputRef.current?.click()}
          />
          {store.docs.length > 0 && (
            <IconButton
              icon={<DeleteIcon />}
              text={Locale.Settings.Knowledge.ClearAll}
              onClick={() => void handleClearAll()}
            />
          )}
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".md,.markdown,.mdx,.txt"
          style={{ display: "none" }}
          onChange={(e) => {
            const files = Array.from(e.currentTarget.files ?? []);
            e.currentTarget.value = "";
            void handleFiles(files);
          }}
        />
      </ListItem>

      {store.docs.map((doc) => (
        <ListItem
          key={doc.id}
          title={doc.name}
          subTitle={Locale.Settings.Knowledge.DocInfo(doc.chunks, doc.chars)}
        >
          <IconButton
            icon={<DeleteIcon />}
            text={Locale.Settings.Knowledge.Remove}
            onClick={() => void handleRemoveDoc(doc.id, doc.name)}
          />
        </ListItem>
      ))}

      {store.docs.length === 0 && (
        <ListItem
          title={Locale.Settings.Knowledge.EmptyHintTitle}
          subTitle={Locale.Settings.Knowledge.EmptyHintSubTitle}
        >
          <IconButton
            icon={<AddIcon />}
            text={Locale.Settings.Knowledge.Import}
            onClick={() => inputRef.current?.click()}
          />
        </ListItem>
      )}
    </List>
  );
}
