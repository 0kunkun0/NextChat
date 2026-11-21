/**
 * 「编辑消息记录」弹窗的窗口化参数。
 *
 * 弹窗里每条消息都是一个可编辑的 textarea，长对话（几百条）一次性全渲染时
 * DOM 和文本会占用大量内存，低端手机/iOS 上打开就直接被浏览器杀进程。
 * 所以只渲染最近的一段，更早的按需点按钮加载。
 */

/** 一次最多渲染多少条 */
export const CONTEXT_PAGE_SIZE = 10;

/**
 * 计算当前要渲染的消息窗口：从最后一条往前取 `count` 条。
 * @param total 消息总数
 * @param count 期望渲染的条数
 */
export function getContextWindow(total: number, count: number) {
  const safeTotal = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
  const requested = Number.isFinite(count) ? Math.floor(count) : 0;
  const visible = Math.max(0, Math.min(safeTotal, requested));
  const start = safeTotal - visible;

  return {
    /** 第一条渲染项在原始数组里的下标 */
    start,
    /** 实际渲染的条数 */
    visible,
    /** 还有多少条更早的没渲染 */
    hidden: start,
    /** 全部渲染出来了才能启用拖拽排序（否则下标对不上） */
    draggable: start === 0,
  };
}

type EditableAttachment = {
  kind: "image" | "file";
  url?: string;
  fileId?: string;
  [key: string]: any;
};

type EditableMessage = {
  content: any;
  attachments?: EditableAttachment[];
  [key: string]: any;
};

/**
 * 编辑一条消息后，算出应该写回 state 的消息。
 *
 * 以前的实现有个坑：它总是拿**旧消息**的 attachments 覆盖新消息的，
 * 于是「编辑时加附件」只有第一次生效（旧列表为空时）——
 * 一次选多个文件只留下一个；删附件也会被旧列表顶回来，看起来“删不掉”。
 *
 * 现在以「新消息的 attachments」为准；只有新消息没带这个字段时
 * （老数据 / 只改文本）才沿用旧的。
 *
 * @param previous 编辑前的消息
 * @param next 编辑后的消息（文本 / 角色 / 附件都可能变了）
 * @param rebuild 用「文本 + 附件」重建 content 的回调
 */
export function resolveEditedMessage<T extends EditableMessage>(
  previous: T | undefined,
  next: T,
  rebuild: (text: string, attachments: any[]) => any,
): T {
  const previousAttachments = previous?.attachments ?? [];
  const text = getTextOf(next);

  // 新消息明确带了 attachments（哪怕空数组）就以它为准；不带才沿用旧的
  let attachments = next.attachments ?? previousAttachments;

  // 老数据：没有 attachments 字段，但 content 里可能存着 image_url 块
  if (next.attachments === undefined && attachments.length === 0) {
    const images = Array.isArray(next.content)
      ? next.content
          .filter((block: any) => block?.type === "image_url")
          .map((block: any) => block.image_url?.url)
          .filter(Boolean)
      : [];
    if (images.length > 0) {
      attachments = images.map((url: string) => ({
        kind: "image" as const,
        url,
        id: url,
        name: "",
        bytes: 0,
        mime: "image/*",
      }));
    }
  }

  // 没有附件：content 退化成纯文本（保持和原来一样的形状）
  if (attachments.length === 0) {
    return { ...next, attachments: [], content: text };
  }

  return {
    ...next,
    attachments,
    content: rebuild(text, attachments),
  };
}
/** 取消息的纯文本内容 */
function getTextOf(message: EditableMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  for (const block of message.content) {
    if (block?.type === "text") return block.text ?? "";
  }
  return "";
}
