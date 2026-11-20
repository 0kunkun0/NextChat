import { getIncludeContent, previewText } from "../store/debug-log";

/**
 * 文本框诊断 + 兜底。
 *
 * 背景：iOS 15 上在输入框里选中一段文字，再点系统菜单的「共享 / 翻译 / 查询」
 * 之后，选中的文字有概率直接消失，而且 Web 端完全没有任何事件线索。
 * iPadOS 17 上复现不了（大概率是 WebKit 后来修了这个 bug）。
 *
 * 这里做两件事：
 * 1. 诊断：把 beforeinput / input / select / 选区变化都打进调试日志
 *    （只在开启「记录前端调试信息」时生效，内容按预览设置截断）；
 * 2. 兜底：如果一次输入事件让文本大幅变短、而且最近没有任何键盘输入
 *    （也就是不是用户自己删的），就当作系统误删，把内容恢复回去并提示。
 */

/** 判定「大幅变短」的阈值（字符数） */
const SUSPICIOUS_SHRINK = 8;
/** 最近多久内按过键，就认为变短是用户自己删的 */
const MANUAL_KEY_WINDOW_MS = 1500;

type DiagnosticOptions = {
  /** 检测到疑似系统误删时回调（已经把 DOM 恢复成旧值） */
  onSuspect?: (restoredValue: string) => void;
  /** 标签，方便区分是哪个输入框 */
  label?: string;
  /**
   * 返回「应用认为当前应该是什么值」（也就是受控组件的 state）。
   *
   * 清空输入框（发送消息）、载入提示词、引用消息这些都是**我们主动**改的值，
   * 不会触发 input 事件，看起来和"被系统吞掉"一模一样。
   * 有了这个回调就能区分：DOM 值和 state 一致 → 是我们自己改的，直接接受。
   */
  getExpectedValue?: () => string;
};

export function attachInputDiagnostics(
  el: HTMLTextAreaElement | HTMLInputElement,
  options: DiagnosticOptions = {},
) {
  const label = options.label ?? "input";
  let lastValue = el.value;
  let lastSelection = {
    start: el.selectionStart ?? 0,
    end: el.selectionEnd ?? 0,
  };
  let lastManualKeyAt = 0;

  /** DOM 的值和应用状态一致 → 是我们自己改的（发送清空等），不是系统误删 */
  const matchesAppState = () => {
    try {
      return options.getExpectedValue?.() === el.value;
    } catch {
      return false;
    }
  };

  const log = (message: string, payload?: any) => {
    // 用 console.debug：既会在控制台可见，也会被调试日志钩子记录
    console.debug(`[Input] ${label} ${message}`, payload ?? "");
  };

  const snapshot = (value: string) => {
    if (getIncludeContent()) return value;
    return `${value.length} chars: ${previewText(value)}`;
  };

  const onKeyDown = () => {
    lastManualKeyAt = Date.now();
  };

  const syncSelection = () => {
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    if (start === lastSelection.start && end === lastSelection.end) return;
    lastSelection = { start, end };
    // 选区变化本身很频繁，只在有选中内容时记录，否则日志会爆
    if (end > start) {
      log("selection", {
        start,
        end,
        text: snapshot(el.value.slice(start, end)),
      });
    }
  };

  const onBeforeInput = (event: Event) => {
    const e = event as InputEvent;
    log("beforeinput", {
      inputType: e.inputType,
      data: e.data ? previewText(e.data) : "",
      isComposing: e.isComposing,
      selection: lastSelection,
      length: el.value.length,
    });
  };

  const onInput = () => {
    const nextValue = el.value;
    syncSelection();

    // 值和 state 一致 → 是我们自己（React）改的，比如发送后清空
    if (matchesAppState()) {
      lastValue = nextValue;
      return;
    }

    const shrink = lastValue.length - nextValue.length;
    const manual = Date.now() - lastManualKeyAt < MANUAL_KEY_WINDOW_MS;

    log("input", {
      from: lastValue.length,
      to: nextValue.length,
      manualKey: manual,
      selection: lastSelection,
      value: snapshot(nextValue),
    });

    // 大幅变短 + 最近没有键盘输入 + 丢失的正好包含之前选中的片段
    // → 当作系统菜单误删，恢复原值
    if (!manual && shrink >= SUSPICIOUS_SHRINK) {
      const selectedBefore = lastValue.slice(
        lastSelection.start,
        lastSelection.end,
      );
      const lostSelection =
        selectedBefore.length > 0 && !nextValue.includes(selectedBefore);

      console.warn("[Input] suspicious shrink, restoring previous value", {
        label,
        from: lastValue.length,
        to: nextValue.length,
        selection: lastSelection,
        lostSelection,
      });

      el.value = lastValue;
      const start = lastSelection.start;
      const end = lastSelection.end;
      try {
        el.setSelectionRange(start, end);
      } catch {
        // 某些元素不支持 setSelectionRange，忽略
      }
      options.onSuspect?.(lastValue);
      return;
    }

    lastValue = nextValue;
  };

  const onSelect = () => syncSelection();

  /**
   * 静默变化检测。
   *
   * iOS 的文本服务有时会**直接改 DOM**，完全不派发 input 事件，
   * 这种情况下 onInput 永远不会触发，光看事件日志是“什么都没有”。
   * 所以聚焦期间每 400ms 对比一次值：变了却没有 input 事件 → 记日志；
   * 如果是大幅变短，同样恢复。
   */
  let watchdog: ReturnType<typeof setInterval> | null = null;

  const checkSilentChange = () => {
    if (el.value === lastValue) return;

    const silentValue = el.value;

    // 和 state 一致 → 是我们自己（React）改的，比如发送后清空输入框
    if (matchesAppState()) {
      lastValue = silentValue;
      return;
    }

    console.warn("[Input] silent value change without input event", {
      label,
      from: lastValue.length,
      to: silentValue.length,
      selection: lastSelection,
      value: snapshot(silentValue),
    });

    // 刚按过键（回车发送、退格等）就不当成系统误删
    const manual = Date.now() - lastManualKeyAt < MANUAL_KEY_WINDOW_MS;

    if (!manual && lastValue.length - silentValue.length >= SUSPICIOUS_SHRINK) {
      console.warn("[Input] restoring after silent shrink", { label });
      el.value = lastValue;
      try {
        el.setSelectionRange(lastSelection.start, lastSelection.end);
      } catch {
        // 忽略
      }
      options.onSuspect?.(lastValue);
      return;
    }

    // 变长 / 小幅变化：当作正常编辑接受
    lastValue = silentValue;
  };

  const onFocus = () => {
    lastValue = el.value;
    syncSelection();
    log("focus", { length: lastValue.length });
    if (watchdog) clearInterval(watchdog);
    watchdog = setInterval(checkSilentChange, 400);
  };

  const onBlur = () => {
    syncSelection();
    log("blur", { length: el.value.length, selection: lastSelection });
    if (watchdog) {
      clearInterval(watchdog);
      watchdog = null;
    }
  };

  el.addEventListener("keydown", onKeyDown, true);
  el.addEventListener("beforeinput", onBeforeInput, true);
  el.addEventListener("input", onInput, true);
  el.addEventListener("select", onSelect);
  el.addEventListener("focus", onFocus);
  el.addEventListener("blur", onBlur);

  return () => {
    el.removeEventListener("keydown", onKeyDown, true);
    el.removeEventListener("beforeinput", onBeforeInput, true);
    el.removeEventListener("input", onInput, true);
    el.removeEventListener("select", onSelect);
    el.removeEventListener("focus", onFocus);
    el.removeEventListener("blur", onBlur);
    if (watchdog) {
      clearInterval(watchdog);
      watchdog = null;
    }
  };
}
