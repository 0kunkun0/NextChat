import { create } from "zustand";

/**
 * 「跳到某条消息」的一次性请求。
 *
 * 搜索页点击某条结果时把 messageId 塞进来，聊天页消费它：
 * 扩大渲染窗口 → 把那条消息滚进视野 → 闪一下。
 *
 * 用独立的小 store 而不是塞进 chat store：
 *   - chat store 会持久化（这个一次性请求没必要写进 localStorage）；
 *   - 需要状态变化触发聊天页 effect（模块级变量不会触发重渲染）。
 */
type ScrollTargetState = {
  messageId: string | null;
  request: (messageId: string) => void;
  consume: () => void;
};

export const useScrollTargetStore = create<ScrollTargetState>((set) => ({
  messageId: null,
  request(messageId: string) {
    set({ messageId });
  },
  consume() {
    set({ messageId: null });
  },
}));
