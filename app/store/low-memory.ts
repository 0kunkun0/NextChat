import { create } from "zustand";

/**
 * 低占用模式。
 *
 * 只存本地（localStorage），**不参与云同步**：
 * 这是"这台设备要不要省内存"的偏好，同步到别的设备反而会互相干扰。
 */

const STORAGE_KEY = "low-memory-mode";

function readInitial() {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch (e) {
    return false;
  }
}

type LowMemoryStore = {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
};

export const useLowMemoryStore = create<LowMemoryStore>((set) => ({
  enabled: typeof window === "undefined" ? false : readInitial(),

  setEnabled(enabled: boolean) {
    try {
      window.localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
    } catch (e) {
      // 隐私模式下写不进去也没关系，当前会话内生效即可
    }
    set({ enabled });
  },
}));
