import ReactMarkdown from "react-markdown";
import "katex/dist/katex.min.css";
import RemarkMath from "remark-math";
import RemarkBreaks from "remark-breaks";
import RehypeKatex from "rehype-katex";
import RemarkGfm from "remark-gfm";
import {
  useRef,
  useState,
  useReducer,
  RefObject,
  useEffect,
  useMemo,
} from "react";
import { copyToClipboard, useWindowSize } from "../utils";
import { getMarkdownInput, remarkFixLiteralStrong } from "../utils/markdown";
import { useThrottleMarkdownRender } from "../utils/use-throttle-markdown";
import {
  canHighlight,
  escapeHtml,
  highlightCode,
  isLanguageLoaded,
  loadLanguage,
  normalizeLanguage,
} from "../utils/highlight-lazy";
import mermaid from "mermaid";
import Locale from "../locales";
import LoadingIcon from "../icons/three-dots.svg";
import ReloadButtonIcon from "../icons/reload.svg";
import React from "react";
import { useDebouncedCallback } from "use-debounce";
import { showImageModal, FullScreen } from "./ui-lib";
import {
  ArtifactsShareButton,
  HTMLPreview,
  HTMLPreviewHandler,
} from "./artifacts";
import { useChatStore } from "../store";
import { IconButton } from "./button";

import { useAppConfig } from "../store/config";
import { useLowMemoryStore } from "../store/low-memory";
import clsx from "clsx";

export function Mermaid(props: { code: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    if (props.code && ref.current) {
      mermaid
        .run({
          nodes: [ref.current],
          suppressErrors: true,
        })
        .catch((e) => {
          setHasError(true);
          console.error("[Mermaid] ", e.message);
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.code]);

  function viewSvgInNewWindow() {
    const svg = ref.current?.querySelector("svg");
    if (!svg) return;
    const text = new XMLSerializer().serializeToString(svg);
    const blob = new Blob([text], { type: "image/svg+xml" });
    showImageModal(URL.createObjectURL(blob));
  }

  if (hasError) {
    return null;
  }

  return (
    <div
      className={clsx("no-dark", "mermaid")}
      style={{
        cursor: "pointer",
        overflow: "auto",
      }}
      ref={ref}
      onClick={() => viewSvgInNewWindow()}
    >
      {props.code}
    </div>
  );
}

export function PreCode(props: { children: any }) {
  const ref = useRef<HTMLPreElement>(null);
  const previewRef = useRef<HTMLPreviewHandler>(null);
  const [mermaidCode, setMermaidCode] = useState("");
  /** mermaid 默认显示图表，可切回源码（参考 DeepSeek demo 的交互） */
  const [showMermaidDiagram, setShowMermaidDiagram] = useState(true);
  const [htmlCode, setHtmlCode] = useState("");
  const { height } = useWindowSize();
  const chatStore = useChatStore();
  const session = chatStore.currentSession();

  const renderArtifacts = useDebouncedCallback(() => {
    if (!ref.current) return;
    const mermaidDom = ref.current.querySelector("code.language-mermaid");
    if (mermaidDom) {
      setMermaidCode((mermaidDom as HTMLElement).textContent ?? "");
    }
    const htmlDom = ref.current.querySelector("code.language-html");
    const refText = ref.current.querySelector("code")?.textContent;
    if (htmlDom) {
      setHtmlCode((htmlDom as HTMLElement).textContent ?? "");
    } else if (
      refText?.startsWith("<!DOCTYPE") ||
      refText?.startsWith("<svg") ||
      refText?.startsWith("<?xml")
    ) {
      setHtmlCode(refText);
    }
  }, 600);

  const config = useAppConfig();
  const enableArtifacts =
    session.mask?.enableArtifacts !== false && config.enableArtifacts;

  //Wrap the paragraph for plain-text
  useEffect(() => {
    if (ref.current) {
      const codeElements = ref.current.querySelectorAll(
        "code",
      ) as NodeListOf<HTMLElement>;
      const wrapLanguages = [
        "",
        "md",
        "markdown",
        "text",
        "txt",
        "plaintext",
        "tex",
        "latex",
      ];
      codeElements.forEach((codeElement) => {
        let languageClass = codeElement.className.match(/language-(\w+)/);
        let name = languageClass ? languageClass[1] : "";
        if (wrapLanguages.includes(name)) {
          codeElement.style.whiteSpace = "pre-wrap";
        }
      });
      setTimeout(renderArtifacts, 1);
    }
  }, []);

  return (
    <>
      <pre ref={ref}>
        <span
          className="copy-code-button"
          onClick={() => {
            if (ref.current) {
              copyToClipboard(
                ref.current.querySelector("code")?.textContent ?? "",
              );
            }
          }}
        ></span>
        {props.children}
      </pre>
      {mermaidCode.length > 0 && (
        <Mermaid code={mermaidCode} key={mermaidCode} />
      )}
      {htmlCode.length > 0 && enableArtifacts && (
        <FullScreen className="no-dark html" right={70}>
          <ArtifactsShareButton
            style={{ position: "absolute", right: 20, top: 10 }}
            getCode={() => htmlCode}
          />
          <IconButton
            style={{ position: "absolute", right: 120, top: 10 }}
            bordered
            icon={<ReloadButtonIcon />}
            shadow
            onClick={() => previewRef.current?.reload()}
          />
          <HTMLPreview
            ref={previewRef}
            code={htmlCode}
            autoHeight={!document.fullscreenElement}
            height={!document.fullscreenElement ? 600 : height}
          />
        </FullScreen>
      )}
    </>
  );
}

/** 把 react-markdown 传来的 children 还原成代码原文 */
function textOfChildren(children: any): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map(textOfChildren).join("");
  if (children && typeof children === "object" && "props" in children) {
    return textOfChildren(children.props?.children);
  }
  return children == null ? "" : String(children);
}

function CustomCode(props: {
  children: any;
  className?: string;
  inline?: boolean;
}) {
  const chatStore = useChatStore();
  const session = chatStore.currentSession();
  const config = useAppConfig();
  const enableCodeFold =
    session.mask?.enableCodeFold !== false && config.enableCodeFold;

  /**
   * 代码高亮按语言动态加载：
   * 未加载时先显示纯文本（不闪烁空白），加载完强制重渲染一次。
   * 低占用模式直接跳过高亮，省下大量 span 和内存。
   */
  const lowMemory = useLowMemoryStore((state) => state.enabled);
  const raw = textOfChildren(props.children);
  const lang = useMemo(
    () =>
      normalizeLanguage(
        /language-([^\s]+)/.exec(props.className ?? "")?.[1] ?? "",
      ),
    [props.className],
  );
  const [version, bumpVersion] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    if (lowMemory || !canHighlight(lang) || isLanguageLoaded(lang)) return;
    let alive = true;
    loadLanguage(lang).then((ok) => {
      if (alive && ok) bumpVersion();
    });
    return () => {
      alive = false;
    };
  }, [lang, lowMemory]);

  const html = useMemo(
    () => (lowMemory ? escapeHtml(raw) : highlightCode(raw, lang)),
    // version 变化代表语言包刚加载完，需要重新高亮
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [raw, lang, lowMemory, version],
  );

  const ref = useRef<HTMLPreElement>(null);
  const [collapsed, setCollapsed] = useState(true);
  const [showToggle, setShowToggle] = useState(false);

  useEffect(() => {
    if (ref.current) {
      const codeHeight = ref.current.scrollHeight;
      setShowToggle(codeHeight > 400);
      ref.current.scrollTop = ref.current.scrollHeight;
    }
  }, [raw, html]);

  const toggleCollapsed = () => {
    setCollapsed((collapsed) => !collapsed);
  };
  const renderShowMoreButton = () => {
    if (showToggle && enableCodeFold && collapsed) {
      return (
        <div
          className={clsx("show-hide-button", {
            collapsed,
            expanded: !collapsed,
          })}
        >
          <button onClick={toggleCollapsed}>{Locale.NewChat.More}</button>
        </div>
      );
    }
    return null;
  };

  // 行内代码不做高亮，也不折叠
  if (props.inline) {
    return <code className={clsx(props.className)}>{props.children}</code>;
  }

  return (
    <>
      <code
        className={clsx(props?.className, "hljs")}
        ref={ref}
        style={{
          maxHeight: enableCodeFold && collapsed ? "400px" : "none",
          overflowY: "hidden",
        }}
        dangerouslySetInnerHTML={{ __html: html }}
      />

      {renderShowMoreButton()}
    </>
  );
}

function _MarkDownContent(props: { content: string; streaming?: boolean }) {
  /**
   * 流式时按「上次渲染耗时」节流：每个 token 都整段重新解析会把低端机主线程堵死，
   * 表现就是“越写越卡”。`streaming` 变 false 后立刻用完整内容渲染，不会丢内容。
   */
  const throttled = useThrottleMarkdownRender(
    props.content,
    props.streaming === true,
  );
  const escapedContent = useMemo(() => {
    return getMarkdownInput(throttled);
  }, [throttled]);

  // 低占用模式：代码高亮会给每个代码块生成大量 span，
  // 长对话里是内存和渲染时间的大头，这里直接跳过
  const lowMemory = useLowMemoryStore((state) => state.enabled);

  return (
    <ReactMarkdown
      remarkPlugins={[
        RemarkMath,
        // singleTilde: false —— 让 ~xxx~ 保持原样，只有 ~~xxx~~ 才是删除线
        [RemarkGfm, { singleTilde: false }],
        RemarkBreaks,
        // 中文里 `**（xxx）**` 这类写法 CommonMark 不认，补救成粗体
        remarkFixLiteralStrong,
      ]}
      // 代码高亮改成在 CustomCode 里按语言动态加载（见 utils/highlight-lazy），
      // 不再用 rehype-highlight：它会把 highlight.js 全部语言打进首屏包
      rehypePlugins={[RehypeKatex]}
      components={{
        pre: PreCode,
        code: CustomCode,
        p: (pProps) => <p {...pProps} dir="auto" />,
        // 表格外包一层可横向滚动的容器：移动端不再把表格压成屏幕宽度，
        // 而是像 GitHub 那样左右滑动查看
        table: ({ node, ...tableProps }) => (
          <div className="markdown-table-wrapper">
            <table {...tableProps} />
          </div>
        ),
        a: (aProps) => {
          const href = aProps.href || "";
          if (/\.(aac|mp3|opus|wav)$/.test(href)) {
            return (
              <figure>
                <audio controls src={href}></audio>
              </figure>
            );
          }
          if (/\.(3gp|3g2|webm|ogv|mpeg|mp4|avi)$/.test(href)) {
            return (
              <video controls width="99.9%">
                <source src={href} />
              </video>
            );
          }
          const isInternal = /^\/#/i.test(href);
          const target = isInternal ? "_self" : aProps.target ?? "_blank";
          return <a {...aProps} target={target} />;
        },
      }}
    >
      {escapedContent}
    </ReactMarkdown>
  );
}

export const MarkdownContent = React.memo(_MarkDownContent);

export function Markdown(
  props: {
    content: string;
    loading?: boolean;
    /** 正在流式输出：内容会持续变化，按渲染耗时节流 */
    streaming?: boolean;
    fontSize?: number;
    fontFamily?: string;
    parentRef?: RefObject<HTMLDivElement>;
    defaultShow?: boolean;
  } & React.DOMAttributes<HTMLDivElement>,
) {
  const mdRef = useRef<HTMLDivElement>(null);

  return (
    <div
      className="markdown-body"
      style={{
        fontSize: `${props.fontSize ?? 14}px`,
        fontFamily: props.fontFamily || "inherit",
      }}
      ref={mdRef}
      onContextMenu={props.onContextMenu}
      dir="auto"
    >
      {props.loading ? (
        <LoadingIcon />
      ) : (
        <MarkdownContent content={props.content} streaming={props.streaming} />
      )}
    </div>
  );
}
