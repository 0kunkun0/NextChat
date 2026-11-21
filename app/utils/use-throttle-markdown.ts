import { useEffect, useRef, useState } from "react";

/**
 * 流式输出时按「上次渲染耗时」节流 Markdown 的解析 + 渲染。
 *
 * 为什么需要：每来一个 token 就整段重新 parse（react-markdown + remark + rehype
 * + 高亮）在低端手机 / iPad 上会直接把主线程堵住，表现为“越写越卡”。
 * 这里的策略是：一次渲染花多久，就等它的 2 倍时间再渲染下一次（最多 2 秒），
 * 期间的新内容合并成最新一份——既不会卡死，也不会看起来停止更新。
 *
 * 做法参考了 DeepSeek 官方 demo 的思路（MIT）。
 * 关闭节流（流式结束）时直接返回最新内容，保证最终结果一定完整。
 */

/** 两次更新的最长间隔（毫秒） */
const MAX_WAIT = 2000;
/** 上次渲染耗时的倍数：过了这段时间才允许下一次更新 */
const TIME_CONSUMING_RATE = 2;

export function useThrottleMarkdownRender(
  content: string,
  streaming: boolean,
): string {
  // 首次渲染从挂载时开始计时
  const startRef = useRef(0);
  const updatableAtRef = useRef(0);
  const [output, setOutput] = useState(content);

  if (startRef.current === 0) {
    startRef.current = now();
  }

  // 每次提交更新后，按这次耗时算出下次允许更新的时间点
  useEffect(() => {
    const current = now();
    updatableAtRef.current =
      current +
      Math.min(MAX_WAIT, (current - startRef.current) * TIME_CONSUMING_RATE);
  }, [output]);

  useEffect(() => {
    if (!streaming) return;

    const update = () => {
      startRef.current = now();
      setOutput(content);
    };

    const delay = updatableAtRef.current - now();
    if (delay <= 0) {
      update();
      return;
    }
    const timer = setTimeout(update, delay);
    return () => clearTimeout(timer);
  }, [content, streaming]);

  return streaming ? output : content;
}

/** performance.now 在极老环境里可能没有，退回 Date.now */
function now(): number {
  return typeof performance !== "undefined" && performance.now
    ? performance.now()
    : Date.now();
}
