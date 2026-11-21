import React, { useEffect, useRef } from "react";

import Locale from "../locales";
import { useKnowledgeStore } from "../store/knowledge";
import { IconButton } from "./button";
import { List, ListItem, showConfirm, showToast } from "./ui-lib";
import AddIcon from "../icons/add.svg";
import DeleteIcon from "../icons/delete.svg";

/**
 * 设置页里的知识库管理：导入 Markdown、查看统计、删除文档。
 *
 * 知识库只存本机 IndexedDB，不参与云同步（1.9MB 文本文档塞进同步会拖垮备份）。
 */
export function KnowledgeSettingsSection() {
  const store = useKnowledgeStore();
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

  return (
    <List>
      <ListItem
        title={Locale.Settings.Knowledge.Title}
        subTitle={Locale.Settings.Knowledge.SubTitle}
      >
        <div style={{ display: "flex", gap: 8 }}>
          <IconButton
            icon={<AddIcon />}
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
              onClick={async () => {
                if (
                  await showConfirm(Locale.Settings.Knowledge.ClearAllConfirm)
                ) {
                  await store.clear();
                }
              }}
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
        <span />
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
            onClick={async () => {
              if (
                await showConfirm(
                  Locale.Settings.Knowledge.RemoveConfirm(doc.name),
                )
              ) {
                await store.remove(doc.id);
              }
            }}
          />
        </ListItem>
      ))}
    </List>
  );
}
