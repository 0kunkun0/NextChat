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
              "align-items:center;justify-content:center;background-color:#fafafa}" +
              "@media (prefers-color-scheme:dark){#boot-splash{background-color:#151515}}" +
              "#boot-splash i{width:28px;height:28px;border-radius:50%;" +
              "border:3px solid rgba(128,128,128,.25);border-top-color:#1d93ab;" +
              "animation:boot-spin .8s linear infinite}" +
              "@keyframes boot-spin{to{transform:rotate(360deg)}}",
          }}
        />
      </head>
      <body>
        {children}
        {/*
          React 挂载前先盖一层纯 CSS 的启动动画：
          老设备上 JS 解析 / 水合要一两秒，这段时间至少不是白屏。
          Home 挂载后会把 #boot-splash 移除；下面的超时是兜底，
          万一水合失败也不会永远卡在转圈上。
        */}
        <div id="boot-splash" aria-hidden="true">
          <i />
        </div>
        <script
          dangerouslySetInnerHTML={{
            __html:
              "setTimeout(function(){var e=document.getElementById('boot-splash');" +
              "if(e)e.remove()},12000)",
          }}
        />
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
