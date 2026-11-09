/**
 * 彻底清掉本地 PWA 缓存：
 * - 注销所有 Service Worker（否则刷新后仍由旧的 SW 接管请求）
 * - 删掉所有 Cache Storage（HTML 外壳 + 静态资源）
 * 然后重载页面，拿到服务器上的最新版本。
 *
 * 用于「改了代码 / 部署了新版本，但 PWA 还在跑旧缓存」的情况。
 */
export async function clearServiceWorkerCache() {
  try {
    if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(
        registrations.map((registration) => registration.unregister()),
      );
    }
  } catch (e) {
    console.warn("[PWA] failed to unregister service worker", e);
  }

  try {
    if (typeof caches !== "undefined") {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
  } catch (e) {
    console.warn("[PWA] failed to clear caches", e);
  }

  if (typeof location !== "undefined") {
    location.reload();
  }
}
