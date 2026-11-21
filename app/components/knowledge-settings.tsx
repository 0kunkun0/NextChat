import React, { useEffect, useRef } from "react";

import Locale from "../locales";
import { useKnowledgeStore } from "../store/knowledge";
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
