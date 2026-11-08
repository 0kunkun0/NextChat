// To store message streaming controller
export const ChatControllerPool = {
  controllers: {} as Record<string, AbortController>,

  /**
   * 请求还没真正发出去（正在拼历史 / 等 MCP 提示词）时用户就点了停止。
   * 这时还没有 AbortController 可以 abort，先记账；等 controller 出现时再立即中止。
   */
  cancelled: new Set<string>(),

  addController(
    sessionId: string,
    messageId: string,
    controller: AbortController,
  ) {
    const key = this.key(sessionId, messageId);

    // 用户在准备阶段就按了停止：直接中止，别真的发请求
    if (this.cancelled.delete(key)) {
      controller.abort();
      return key;
    }

    this.controllers[key] = controller;
    return key;
  },

  stop(sessionId: string, messageId: string) {
    const key = this.key(sessionId, messageId);
    const controller = this.controllers[key];

    if (controller) {
      controller.abort();
      return;
    }

    // 请求还没发出去：记一笔，等 addController 时立刻中止
    this.cancelled.add(key);
  },

  isCancelled(sessionId: string, messageId: string) {
    return this.cancelled.has(this.key(sessionId, messageId));
  },

  stopAll() {
    Object.values(this.controllers).forEach((v) => v.abort());
  },

  hasPending() {
    return Object.values(this.controllers).length > 0;
  },

  remove(sessionId: string, messageId: string) {
    const key = this.key(sessionId, messageId);
    delete this.controllers[key];
    this.cancelled.delete(key);
  },

  key(sessionId: string, messageIndex: string) {
    return `${sessionId},${messageIndex}`;
  },
};
