import { jest } from "@jest/globals";

import { createPortalLayer, getPortalHost } from "../app/utils/portal";

/**
 * 弹层容器必须是「只创建一次、永不删除」的固定节点。
 *
 * 以前 showToast / showModal 都是每次 new 一个 div 直接塞进 document.body、
 * 用完再 remove。在 Next App Router 里 body 的子节点归 React 管，
 * 外部增删会让 React 记录的 child 指针失效，之后提交 Suspense / lazy 子树时
 * 就会抛 NotFoundError: removeChild ... is not a child of this node。
 */
describe("portal host", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  test("只创建一个容器，多次调用复用同一个", () => {
    const first = getPortalHost();
    const second = getPortalHost();

    expect(first).toBe(second);
    expect(document.querySelectorAll("#nextchat-portal-host")).toHaveLength(1);
    // 容器必须挂在 body 下，否则弹层定位会错
    expect(first.parentElement).toBe(document.body);
  });

  test("弹层挂在容器内部，而不是 body 的直接子节点", () => {
    const layer = createPortalLayer("modal-mask");

    expect(layer.container.parentElement).toBe(getPortalHost());
    expect(layer.container.parentElement).not.toBe(document.body);

    layer.destroy();
  });

  test("destroy 可以重复调用且不抛错", () => {
    const layer = createPortalLayer("modal-mask");

    expect(() => {
      layer.destroy();
      layer.destroy();
    }).not.toThrow();
    expect(layer.container.isConnected).toBe(false);
  });

  test("容器本身在弹层销毁后依然存在", () => {
    const host = getPortalHost();
    const layer = createPortalLayer("modal-mask");
    layer.destroy();

    expect(host.isConnected).toBe(true);
    expect(getPortalHost()).toBe(host);
  });
});
