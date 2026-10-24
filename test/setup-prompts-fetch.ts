// 必须在导入 app/utils/sync 之前执行：
// store/prompt.ts（fetch prompts.json）和 store/plugin.ts（fetch 插件列表）
// 在模块加载时就会请求资源，jest.setup 里的 fetch mock 对所有 URL 都返回 []，
// 会让内置提示词初始化崩掉，所以这里按 URL 返回不同的结构。
(globalThis as any).fetch = (url: unknown) => {
  const isPrompts = String(url).includes("prompts.json");
  const body = isPrompts ? { en: [], cn: [], tw: [] } : [];

  return Promise.resolve({
    ok: true,
    status: 200,
    statusText: "OK",
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(""),
  });
};
