import type { ChatMessage } from "../store/chat";

/**
 * 消息操作栏是否显示。
 *
 * 有内容时当然要显示；**正在生成时也要显示**——否则刚点「发送」/「重新生成」，
 * 内容被清空、还没吐出第一个字的那几秒里，操作栏会整行消失，
 * 连「停止」按钮都按不到。
 */
export function shouldShowMessageActions(
  message: ChatMessage & { preview?: boolean },
  isContext: boolean,
  index: number,
) {
  if (index <= 0 || isContext) return false;
  if (message.preview) return false;
  return message.content.length > 0 || !!message.streaming;
}
