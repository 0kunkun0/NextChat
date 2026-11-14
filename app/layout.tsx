/* eslint-disable @next/next/no-page-custom-font */
import "./styles/globals.scss";
import "./styles/markdown.scss";
import "./styles/highlight.scss";
import { getClientConfig } from "./config/client";
import type { Metadata, Viewport } from "next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { GoogleTagManager, GoogleAnalytics } from "@next/third-parties/google";
import { getServerSideConfig } from "./config/server";

export const metadata: Metadata = {
  title: "NextChat",
  description: "Your personal ChatGPT Chat Bot.",
  appleWebApp: {
    title: "NextChat",
    statusBarStyle: "default",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fafafa" },
    { media: "(prefers-color-scheme: dark)", color: "#151515" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const serverConfig = getServerSideConfig();

  return (
    <html lang="en">
      <head>
        <meta name="config" content={JSON.stringify(getClientConfig())} />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"
        />
        <link
          rel="manifest"
          href="/site.webmanifest"
          crossOrigin="use-credentials"
        ></link>
        <script src="/serviceWorkerRegister.js" defer></script>
        {/*
          首屏兜底背景色：CSS 还没下载完 / PWA 冷启动时先铺上正确的底色，
          否则会闪一下白屏（深色主题下尤其明显）
        */}
        <style
          dangerouslySetInnerHTML={{
            __html:
              "html,body{margin:0;background-color:#fafafa}" +
              "@media (prefers-color-scheme:dark){html,body{background-color:#151515}}" +
              // 静态启动动画：不依赖 JS，HTML 一画出来就有东西看
              "#boot-splash{position:fixed;inset:0;z-index:99999;display:flex;" +
              "align-items:center;justify-content:center;background-color:#fafafa;" +
              "transition:opacity .2s ease}" +
              "@media (prefers-color-scheme:dark){#boot-splash{background-color:#151515}}" +
              "#boot-splash i{width:28px;height:28px;border-radius:50%;" +
              "border:3px solid rgba(128,128,128,.25);border-top-color:#1d93ab;" +
              "animation:boot-spin .8s linear infinite}" +
              "@keyframes boot-spin{to{transform:rotate(360deg)}}" +
              // React 挂载后给 <html> 加 .app-ready，用 CSS 把它藏起来。
              // 千万不要用 JS 把这个节点 remove 掉：它是 React 渲染的，
              // 手动删会破坏 React 的 DOM 引用，随后 commit 阶段就会抛
              // "insertBefore / removeChild: node is not a child of this node"
              "html.app-ready #boot-splash{display:none}" +
              // 万一 JS 彻底没跑起来（离线 / 老浏览器），10 秒后也让它自己淡出
              "#boot-splash{animation:boot-bail .3s ease 10s forwards}" +
              "@keyframes boot-bail{to{opacity:0;visibility:hidden}}",
          }}
        />
      </head>
      <body>
        {children}
        {/*
          React 挂载前先盖一层纯 CSS 的启动动画：
          老设备上 JS 解析 / 水合要一两秒，这段时间至少不是白屏。
          注意：这个节点由 React 渲染并管理，只能通过 CSS 隐藏（html.app-ready），
          不能在外部 remove，否则会破坏 React 的 DOM 树导致整页崩溃。
        */}
        <div id="boot-splash" aria-hidden="true">
          <i />
        </div>
        {serverConfig?.isVercel && (
          <>
            <SpeedInsights />
          </>
        )}
        {serverConfig?.gtmId && (
          <>
            <GoogleTagManager gtmId={serverConfig.gtmId} />
          </>
        )}
        {serverConfig?.gaId && (
          <>
            <GoogleAnalytics gaId={serverConfig.gaId} />
          </>
        )}
      </body>
    </html>
  );
}
