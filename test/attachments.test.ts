import {
  ACCEPTED_EXTS,
  MAX_DOCUMENT_MB,
  MAX_IMAGE_MB,
  MAX_USER_DATA_MB,
  formatSize,
  getFileExt,
  getMaxSizeMB,
  getUploadPurpose,
  isImageFile,
} from "../app/utils/attachment-rules";
import { rebuildContent } from "../app/utils/attachment-rules";

/**
 * DeepSeek Files API 的客户端约束：
 * - 图片（png/jpg/gif/webp）用 user_data，上限 64MB
 * - PDF / Word / PowerPoint 需要版面解析，上限 100MB
 * - 纯文本 / 表格 / 电子书用 user_data，上限 32MB
 */
describe("attachments: 类型与上限", () => {
  test("按扩展名判断 purpose", () => {
    expect(getUploadPurpose("a.png", true)).toBe("user_data");
    expect(getUploadPurpose("报告.pdf", false)).toBe("rich_layout_recognition");
    expect(getUploadPurpose("方案.docx", false)).toBe(
      "rich_layout_recognition",
    );
    expect(getUploadPurpose("幻灯片.pptx", false)).toBe(
      "rich_layout_recognition",
    );
    expect(getUploadPurpose("notes.md", false)).toBe("user_data");
    expect(getUploadPurpose("data.xlsx", false)).toBe("user_data");
    expect(getUploadPurpose("main.py", false)).toBe("user_data");
    // 不支持的类型
    expect(getUploadPurpose("archive.zip", false)).toBeNull();
    expect(getUploadPurpose("app.exe", false)).toBeNull();
  });

  test("大小上限按类型区分", () => {
    expect(getMaxSizeMB("a.jpg", true)).toBe(MAX_IMAGE_MB);
    expect(getMaxSizeMB("a.pdf", false)).toBe(MAX_DOCUMENT_MB);
    expect(getMaxSizeMB("a.txt", false)).toBe(MAX_USER_DATA_MB);
  });

  test("图片识别优先看 MIME，其次看扩展名", () => {
    expect(isImageFile({ name: "x", type: "image/png" })).toBe(true);
    expect(isImageFile({ name: "x.webp" })).toBe(true);
    expect(isImageFile({ name: "x.pdf", type: "application/pdf" })).toBe(false);
  });

  test("accept 列表覆盖文档与文本", () => {
    expect(ACCEPTED_EXTS).toContain("pdf");
    expect(ACCEPTED_EXTS).toContain("docx");
    expect(ACCEPTED_EXTS).toContain("md");
    expect(ACCEPTED_EXTS).toContain("png");
  });

  test("扩展名与体积格式化", () => {
    expect(getFileExt("a.b.PDF")).toBe("pdf");
    expect(getFileExt("noext")).toBe("");
    expect(formatSize(0)).toBe("");
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(2048)).toBe("2.0 KB");
    expect(formatSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("rebuildContent", () => {
  test("文本 + 图片 + 文件块按顺序重建", () => {
    const blocks = rebuildContent("看这两份文件", [
      {
        id: "img1",
        kind: "image",
        name: "a.png",
        bytes: 10,
        mime: "image/png",
        url: "data:image/png;base64,AAA",
      },
      {
        id: "file1",
        kind: "file",
        name: "b.pdf",
        bytes: 20,
        mime: "application/pdf",
        fileId: "file-api-1",
      },
      // 没有 fileId 的占位（上传失败）不会被塞进请求
      {
        id: "file2",
        kind: "file",
        name: "c.pdf",
        bytes: 30,
        mime: "application/pdf",
      },
    ]);

    expect(blocks).toEqual([
      { type: "text", text: "看这两份文件" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
      { type: "file", file_id: "file-api-1" },
    ]);
  });

  test("没有附件时退化成纯文本块", () => {
    expect(rebuildContent("只有文字", [])).toEqual([
      { type: "text", text: "只有文字" },
    ]);
  });
});
