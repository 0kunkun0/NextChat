const CHATGPT_NEXT_WEB_CACHE = "chatgpt-next-web-cache";
const CHATGPT_NEXT_WEB_FILE_CACHE = "chatgpt-next-web-file";
/** 页面外壳（HTML）：缓存优先，后台更新 */
const APP_SHELL_CACHE = "chatgpt-next-web-shell-v1";
/** 带 hash 的静态资源：内容不会变，缓存优先 */
const APP_STATIC_CACHE = "chatgpt-next-web-static-v1";
let a="useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";let nanoid=(e=21)=>{let t="",r=crypto.getRandomValues(new Uint8Array(e));for(let n=0;n<e;n++)t+=a[63&r[n]];return t};

self.addEventListener("fetch", function (event) {
  const request = event.request;
  if (request.method !== "GET") return;

  let url;
  try {
    url = new URL(request.url);
  } catch (e) {
    return;
  }

  // 只处理自己的资源；接口一律走网络，绝不缓存聊天响应
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;
  if (url.pathname === "/serviceWorker.js") return;

  // 打开页面 / 切回 PWA：先给缓存（秒开），同时后台拉最新版本回填缓存
  if (request.mode === "navigate") {
    event.respondWith(staleWhileRevalidate(request, APP_SHELL_CACHE));
    return;
  }

  // Next 的 /_next/static 带内容 hash，文件名变了内容才会变 → 缓存优先
  if (
    url.pathname.startsWith("/_next/static/") ||
    ["script", "style", "font", "image"].includes(request.destination)
  ) {
    event.respondWith(cacheFirst(request, APP_STATIC_CACHE));
  }
});

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  // 后台更新：不管有没有命中缓存，都去服务器要一份新的
  const networkPromise = fetch(request)
    .then((response) => {
      if (response && response.ok) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  if (cached) {
    // 不 await，让页面立刻用缓存渲染
    networkPromise.catch(() => {});
    return cached;
  }

  const fresh = await networkPromise;
  return (
    fresh ||
    new Response("离线且没有缓存", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    })
  );
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request).catch(() => null);
  if (response && response.ok) {
    cache.put(request, response.clone());
  }
  return response || Response.error();
}

self.addEventListener("activate", function (event) {
  console.log("ServiceWorker activated.");
  event.waitUntil(
    (async () => {
      // 注意：这里不能删 APP_SHELL_CACHE。
      // 首次安装时 install 刚把首页预热进去，activate 紧接着执行，
      // 删掉就等于白预热了（这就是之前每次冷启动还是白屏的原因）。
      // 版本更新交给导航请求的 stale-while-revalidate 在后台刷新。

      // 清理不属于当前版本的缓存
      const keep = [
        CHATGPT_NEXT_WEB_CACHE,
        CHATGPT_NEXT_WEB_FILE_CACHE,
        APP_SHELL_CACHE,
        APP_STATIC_CACHE,
      ];
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => !keep.includes(key)).map((key) => caches.delete(key)),
      );

      await self.clients.claim();
    })(),
  );
});

self.addEventListener("install", function (event) {
  self.skipWaiting();  // enable new version
  event.waitUntil(
    (async () => {
      await caches.open(CHATGPT_NEXT_WEB_CACHE);

      // 装好之后预缓存首页和三方资源：
      // 这样第一次打开（以及之后每次启动）都能直接命中缓存，不用等服务器
      try {
        const response = await fetch("/", { cache: "no-store" });
        if (!response || !response.ok) return;

        const html = await response.clone().text();
        const shell = await caches.open(APP_SHELL_CACHE);
        await shell.put("/", response);

        // 首页里引用的 JS / CSS 一起抓下来，避免首次启动还要等网络
        const assets = Array.from(
          html.matchAll(/(?:src|href)="(\/_next\/static\/[^"]+)"/g),
        ).map((match) => match[1]);

        const staticCache = await caches.open(APP_STATIC_CACHE);
        await Promise.all(
          assets.map(async (url) => {
            try {
              const asset = await fetch(url);
              if (asset && asset.ok) await staticCache.put(url, asset.clone());
            } catch (e) {
              // 单个资源失败不影响整体
            }
          }),
        );
      } catch (e) {
        // 离线安装之类的场景，忽略即可，首次打开时还会再缓存
      }
    })(),
  );
});

function jsonify(data) {
  return new Response(JSON.stringify(data), {
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-credentials': 'true',
    }
  })
}

async function upload(request, url) {
  const cloned = request.clone();
  let ct = "(unknown)";
  let bodyUsed = "(unknown)";
  let hasBody = false;
  try {
    ct = cloned.headers.get('content-type') || '(none)';
    bodyUsed = cloned.bodyUsed;
    hasBody = !!cloned.body;
  } catch (e) {}

  try {
    const formData = await request.formData();
    const file = formData.getAll('file')[0];
    console.log("[SW] upload called, file =", file);
    if (!file) {
      return jsonify({ code: -1, error: "no file in formData" });
    }
    let ext = file.name.split('.').pop();
    if (ext === 'blob') {
      ext = file.type.split('/').pop();
    }
    const fileUrl = `${url.origin}/api/cache/${nanoid()}.${ext}`;
    const cache = await caches.open(CHATGPT_NEXT_WEB_FILE_CACHE);
    await cache.put(new Request(fileUrl), new Response(file, {
      headers: {
        'content-type': file.type || 'application/octet-stream',
        'content-length': String(file.size),
        'cache-control': 'no-cache',
        'server': 'ServiceWorker',
      }
    }));
    return jsonify({ code: 0, data: fileUrl });
  } catch (e) {
      return jsonify({ 
        code: -1, 
        error: e.message,
        name: e.name,
        stack: e.stack,
        debug: {
          contentType: request.headers.get('content-type'),
          bodyUsed: request.bodyUsed,
          hasBody: !!request.body,
          method: request.method,
        }
      });
}
}

async function remove(request, url) {
  const cache = await caches.open(CHATGPT_NEXT_WEB_FILE_CACHE)
  const res = await cache.delete(request.url)
  return jsonify({ code: 0 })
}

/* self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (/^\/api\/cache/.test(url.pathname)) {
    if ('GET' == e.request.method) {
      e.respondWith(caches.match(e.request))
    }
    if ('POST' == e.request.method) {
      e.respondWith(upload(e.request, url))
    }
    if ('DELETE' == e.request.method) {
      e.respondWith(remove(e.request, url))
    }
  }
}); */

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (/^\/api\/cache/.test(url.pathname)) {
    if ('POST' == e.request.method) {
      // 直接返回 debug 信息，不发请求
      e.respondWith(new Response(JSON.stringify({
        code: -1,
        error: "debug only",
        debug: {
          contentType: e.request.headers.get('content-type'),
          bodyUsed: e.request.bodyUsed,
          hasBody: !!e.request.body,
          url: e.request.url,
        }
      }), { headers: { 'content-type': 'application/json' } }));
      return;
    }
  }
});