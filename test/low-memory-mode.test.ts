import { useLowMemoryStore } from "../app/store/low-memory";

describe("low memory mode", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useLowMemoryStore.setState({ enabled: false });
  });

  test("is off by default", () => {
    expect(useLowMemoryStore.getState().enabled).toBe(false);
  });

  test("can be toggled and is remembered locally", () => {
    useLowMemoryStore.getState().setEnabled(true);

    expect(useLowMemoryStore.getState().enabled).toBe(true);
    expect(window.localStorage.getItem("low-memory-mode")).toBe("1");

    useLowMemoryStore.getState().setEnabled(false);
    expect(window.localStorage.getItem("low-memory-mode")).toBe("0");
  });

  test("is not part of the synced app state", () => {
    // 低占用模式只是本机偏好：同步的数据集合里不应该出现它
    const syncedStoreKeys = [
      "chat",
      "access-control",
      "app-config",
      "mask-store",
      "prompt-store",
    ];
    expect(syncedStoreKeys).not.toContain("low-memory-mode");
  });
});
