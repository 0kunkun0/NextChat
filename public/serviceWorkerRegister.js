if ("serviceWorker" in navigator) {
  window.addEventListener("load", function () {
    // 页面加载时是否已经有 SW 在控制：
    // 第一次安装不需要刷新；只有“旧版本被新版本替换”时才刷新一次
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;

    navigator.serviceWorker.addEventListener("controllerchange", function () {
      if (!hadController || reloading) return;
      reloading = true;
      console.log("[SW] new version activated, reload");
      window.location.reload();
    });

    navigator.serviceWorker
      .register("/serviceWorker.js", { scope: "/" })
      .then(function (registration) {
        console.log(
          "[SW] registration successful with scope: ",
          registration.scope,
        );
        // 每次打开都检查一下有没有新版本；失败了也不影响使用
        registration.update().catch(function () {});
        window._SW_ENABLED = true;
      })
      .catch(function (err) {
        console.error("[SW] registration failed: ", err);
      });
  });
}
