import { createRoot, type Root } from "react-dom/client";

/**
 * 弹层（Toast / 模态框）的挂载点。
 *
 * 为什么不能像以前那样「每次 new 一个 div 塞进 document.body，用完 remove」：
 * 在 Next.js App Router 里 React 的根节点就是 <html>，`document.body` 的子节点
 * 也归 React 管。外部往里增删兄弟节点会让 React 记录的 child 指针失效，
 * 之后只要触发一次 Suspense / lazy 组件的提交，就会抛
 *
 *   NotFoundError: Failed to execute 'removeChild' on 'Node':
 *   The node to be removed is not a child of this node.
 *
 * 所以这里只创建**一个**固定容器，之后所有弹层都挂在它内部；
 * 这个容器本身只创建一次、永不删除，React 永远不会看到 body 的子节点数变化。
 */

const PORTAL_HOST_ID = "nextchat-portal-host";

let cachedHost: HTMLElement | null = null;

/** 拿到（必要时创建）稳定的弹层容器 */
export function getPortalHost(): HTMLElement {
  if (cachedHost && cachedHost.isConnected) return cachedHost;

  const existing = document.getElementById(PORTAL_HOST_ID);
  if (existing) {
    cachedHost = existing;
    return existing;
  }

  const host = document.createElement("div");
  host.id = PORTAL_HOST_ID;
  document.body.appendChild(host);
  cachedHost = host;
  return host;
}

export type PortalLayer = {
  /** 这个弹层自己的容器（交给 createRoot 用） */
  container: HTMLElement;
  root: Root;
  /** 卸载并移除这一层（失败也不抛） */
  destroy: () => void;
};

/** 在弹层容器里挂一层新的 React root */
export function createPortalLayer(className?: string): PortalLayer {
  const container = document.createElement("div");
  if (className) container.className = className;
  getPortalHost().appendChild(container);

  const root = createRoot(container);

  let destroyed = false;
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    try {
      root.unmount();
    } catch (e) {
      console.warn("[Portal] unmount failed", e);
    }
    // remove() 不会像 removeChild 那样在父子关系不一致时抛错
    container.remove();
  };

  return { container, root, destroy };
}
