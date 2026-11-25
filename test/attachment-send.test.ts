import {
  collectUploadedAttachments,
  hasPendingAttachments,
  rebuildContent,
} from "../app/utils/attachment-rules";
import type { ChatAttachment } from "../app/store/chat";

/**
 * 「📎 上传文件」传的图片发不出去：
 * 它在输入框上有 chip（kind: "image" + file_id），但发送时被
 * `kind === "file"` 这个条件过滤掉了 —— 模型看不到，消息里也没有附件记录，
 * 编辑历史自然也看不到。
 */
const imageViaFilesApi: ChatAttachment = {
  id: "att-img-1",
  kind: "image",
  name: "shot.png",
  bytes: 1200,
  mime: "image/png",
  fileId: "file-abc",
  purpose: "user_data",
};

const docViaFilesApi: ChatAttachment = {
  id: "att-doc-1",
  kind: "file",
  name: "manual.pdf",
  bytes: 4096,
  mime: "application/pdf",
  fileId: "file-def",
};

const pendingImage: ChatAttachment = {
  id: "pending-1",
  kind: "image",
  name: "uploading.png",
  bytes: 900,
  mime: "image/png",
};

const pendingDoc: ChatAttachment = {
  id: "pending-2",
  kind: "file",
  name: "uploading.pdf",
  bytes: 900,
  mime: "application/pdf",
};

describe("collectUploadedAttachments", () => {
  test("图片只要拿到 file_id 也要发给模型（回归：以前被丢掉）", () => {
    const picked = collectUploadedAttachments([
      imageViaFilesApi,
      docViaFilesApi,
    ]);
    expect(picked.map((item) => item.id)).toEqual(["att-img-1", "att-doc-1"]);
  });

  test("还在上传（没有 file_id）的不算", () => {
    const picked = collectUploadedAttachments([pendingImage, pendingDoc]);
    expect(picked).toEqual([]);
  });

  test("空列表 / undefined 安全", () => {
    expect(collectUploadedAttachments(undefined)).toEqual([]);
    expect(collectUploadedAttachments([])).toEqual([]);
  });
});

describe("hasPendingAttachments", () => {
  test("有占位 chip（没 file_id）就是还在传", () => {
    expect(hasPendingAttachments([pendingImage])).toBe(true);
    expect(hasPendingAttachments([docViaFilesApi, pendingDoc])).toBe(true);
  });

  test("全部上传完成 → false", () => {
    expect(hasPendingAttachments([imageViaFilesApi, docViaFilesApi])).toBe(
      false,
    );
    expect(hasPendingAttachments(undefined)).toBe(false);
  });
});

describe("rebuildContent：编辑历史里重建 content", () => {
  test("Files API 的图片重建为 file 块（而不是被忽略）", () => {
    const blocks = rebuildContent("看图", [imageViaFilesApi]);
    expect(blocks).toEqual([
      { type: "text", text: "看图" },
      { type: "file", file_id: "file-abc" },
    ]);
  });

  test("base64 图片仍然走 image_url 块", () => {
    const blocks = rebuildContent("图", [
      {
        id: "img-1",
        kind: "image",
        name: "a.png",
        bytes: 1,
        mime: "image/png",
        url: "data:image/png;base64,AAA",
      },
    ]);
    expect(blocks).toEqual([
      { type: "text", text: "图" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
    ]);
  });
});
