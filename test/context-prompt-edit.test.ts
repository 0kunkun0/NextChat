import { resolveEditedMessage } from "../app/utils/context-prompt";

/**
 * 编辑消息记录时附件的新增 / 删除。
 *
 * 旧实现每次都拿**旧消息**的 attachments 覆盖新消息的，导致两个 bug：
 *   1. 一次选多个文件只上传/保留了一个（旧列表为空的那一次才生效）；
 *   2. 删除附件会被旧列表顶回来，看起来“删不掉”。
 */
const rebuild = (text: string, attachments: any[]) => {
  const blocks: any[] = [];
  if (text) blocks.push({ type: "text", text });
  for (const item of attachments) {
    if (item.kind === "image" && item.url) {
      blocks.push({ type: "image_url", image_url: { url: item.url } });
    } else if (item.fileId) {
      blocks.push({ type: "file", file_id: item.fileId });
    }
  }
  return blocks;
};

const file = (id: string) => ({
  id,
  kind: "file" as const,
  name: `${id}.pdf`,
  bytes: 100,
  mime: "application/pdf",
  fileId: `file-api-${id}`,
});

const image = (id: string) => ({
  id,
  kind: "image" as const,
  name: `${id}.png`,
  bytes: 50,
  mime: "image/png",
  url: `data:image/png;base64,${id}`,
});

describe("resolveEditedMessage", () => {
  test("一次新增多个附件时全部保留（不再只留一个）", () => {
    const previous = { content: "原文本", attachments: [] as any[] };
    const next = {
      ...previous,
      attachments: [file("a"), file("b"), file("c")],
    };

    const result = resolveEditedMessage(previous as any, next as any, rebuild);
    expect(result.attachments).toHaveLength(3);
    expect(result.attachments?.map((item: any) => item.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    // content 里也要有三个 file 块
    const fileBlocks = (result.content as any[]).filter(
      (block) => block.type === "file",
    );
    expect(fileBlocks).toHaveLength(3);
  });

  test("删除某个附件后不会被打回原样", () => {
    const previous = {
      content: "原文本",
      attachments: [file("a"), file("b")],
    };
    const next = { ...previous, attachments: [file("b")] };

    const result = resolveEditedMessage(previous as any, next as any, rebuild);
    expect(result.attachments?.map((item: any) => item.id)).toEqual(["b"]);
    expect(
      (result.content as any[]).filter((block) => block.type === "file"),
    ).toHaveLength(1);
  });

  test("删光附件后 content 退化为纯文本", () => {
    const previous = { content: "原文本", attachments: [file("a")] };
    const next = { ...previous, attachments: [] };

    const result = resolveEditedMessage(previous as any, next as any, rebuild);
    expect(result.attachments).toEqual([]);
    expect(result.content).toBe("原文本");
  });

  test("只改文本（没带 attachments 字段）时沿用旧附件", () => {
    const previous = { content: "原文本", attachments: [file("a")] };
    const next = { content: "改过的文本" };

    const result = resolveEditedMessage(previous as any, next as any, rebuild);
    expect(result.attachments?.map((item: any) => item.id)).toEqual(["a"]);
    expect((result.content as any[])[0]).toEqual({
      type: "text",
      text: "改过的文本",
    });
  });

  test("老数据：只有 image_url 块、没有 attachments 字段也能保留图片", () => {
    const previous = {
      content: [
        { type: "text", text: "旧文本" },
        { type: "image_url", image_url: { url: "data:image/png;base64,x" } },
      ] as any,
    };
    const next = {
      content: [
        { type: "text", text: "新文本" },
        { type: "image_url", image_url: { url: "data:image/png;base64,x" } },
      ] as any,
    };

    const result = resolveEditedMessage(previous as any, next as any, rebuild);
    const blocks = result.content as any[];
    expect(blocks[0]).toEqual({ type: "text", text: "新文本" });
    expect(blocks[1]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,x" },
    });
  });

  test("图片和文件混合时顺序保持不变", () => {
    const previous = { content: "文本", attachments: [] as any[] };
    const next = {
      ...previous,
      attachments: [image("i1"), file("f1"), image("i2")],
    };

    const result = resolveEditedMessage(previous as any, next as any, rebuild);
    const types = (result.content as any[]).map((block) => block.type);
    expect(types).toEqual(["text", "image_url", "file", "image_url"]);
  });
});
