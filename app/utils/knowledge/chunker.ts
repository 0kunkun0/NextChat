/**
 * Markdown 分块：按标题切分，**代码围栏内绝不切**。
 *
 * 这套规则和 `scripts/md-chunk-preview.mjs` 保持一致（那个脚本就是用来
 * 在导入前预览切分效果的），但这里去掉了 CLI 相关的部分。
 */

export type MarkdownFence = {
  lang: string;
  start: number;
  end: number;
  unclosed?: boolean;
};

export type MarkdownSection = {
  /** Markdown 标题路径，例如 "安装 > 依赖 > Node 版本" */
  headingPath: string;
  /** 切分用的标题层级（0 表示前言） */
  level: number;
  /** 标题文本 */
  heading: string;
  /** 原始 Markdown 片段（含标题行与其中的代码块） */
  text: string;
  chars: number;
  codeChars: number;
  codeBlocks: number;
  /** 粗略 token 估算：正文 2.2 字符/token，代码 3.5 字符/token */
  estTokens: number;
  startLine: number;
  endLine: number;
};

export type ChunkStats = {
  sections: number;
  chars: number;
  codeChars: number;
  codeBlocks: number;
  unclosedFences: number;
  oversized: number;
};

export type ChunkOptions = {
  /** 用哪一级标题切，默认 3（H3） */
  level?: number;
  /** 小于这个字数的节并入下一节，默认 200 */
  minChars?: number;
  /** 单节软上限，超出时尝试用更深标题再切，默认 20000 */
  maxChars?: number;
};

const TEXT_CHARS_PER_TOKEN = 2.2;
const CODE_CHARS_PER_TOKEN = 3.5;
const DEFAULT_OPTIONS: Required<ChunkOptions> = {
  level: 3,
  minChars: 200,
  maxChars: 20000,
};

type Heading = {
  level: number;
  text: string;
  line: number;
  setext?: boolean;
};

type RawSection = MarkdownSection & { headingRef?: Heading | null };

/**
 * 把一篇 Markdown 切成检索用的节。
 * @param markdown 原始文本
 * @param options 切分参数
 */
export function chunkMarkdown(
  markdown: string,
  options: ChunkOptions = {},
): { sections: MarkdownSection[]; fences: MarkdownFence[]; stats: ChunkStats } {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const normalized = markdown.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");

  const { headings, fences, unclosed } = scan(lines);
  const paths = buildHeadingPaths(headings);

  let sections = buildSections(lines, headings, opts.level, paths);
  sections = expandOversized(lines, headings, sections, opts.maxChars, paths);
  sections = mergeTiny(lines, sections, opts.minChars, paths);

  // 计算标题路径（合并后的节沿用第一节的起始行）
  const withPaths = sections.map((section) => ({
    ...section,
    headingPath: paths.get(section.startLine) ?? section.headingPath ?? "",
  }));

  const stats: ChunkStats = {
    sections: withPaths.length,
    chars: withPaths.reduce((sum, s) => sum + s.chars, 0),
    codeChars: withPaths.reduce((sum, s) => sum + s.codeChars, 0),
    codeBlocks: withPaths.reduce((sum, s) => sum + s.codeBlocks, 0),
    unclosedFences: fences.filter((f) => f.unclosed).length,
    oversized: withPaths.filter((s) => s.chars > opts.maxChars).length,
  };

  return { sections: withPaths, fences, stats };
}

/* ------------------------------ 扫描 ------------------------------ */

function scan(lines: string[]) {
  const headings: Heading[] = [];
  const fences: MarkdownFence[] = [];
  let unclosed = false;

  let start = 0;
  // YAML front matter
  if (lines[0]?.trim() === "---") {
    for (let i = 1; i < Math.min(lines.length, 200); i++) {
      if (lines[i].trim() === "---") {
        start = i + 1;
        break;
      }
    }
  }

  let open: { char: string; len: number; lang: string; start: number } | null =
    null;

  for (let i = start; i < lines.length; i++) {
    const line = lines[i];

    if (open) {
      const close = line.match(/^\s{0,3}(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === open.char && close[1].length >= open.len) {
        fences.push({ lang: open.lang, start: open.start, end: i });
        open = null;
      }
      continue;
    }

    const fenceOpen = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (fenceOpen) {
      open = {
        char: fenceOpen[1][0],
        len: fenceOpen[1].length,
        lang: (fenceOpen[2] ?? "").trim().split(/\s+/)[0] ?? "",
        start: i,
      };
      continue;
    }

    const atx = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (atx) {
      headings.push({ level: atx[1].length, text: atx[2].trim(), line: i });
      continue;
    }

    const underline = lines[i + 1];
    if (line.trim() && underline) {
      const m = underline.match(/^\s{0,3}(=+|-{2,})\s*$/);
      if (m) {
        headings.push({
          level: m[1][0] === "=" ? 1 : 2,
          text: line.trim(),
          line: i,
          setext: true,
        });
        i++;
      }
    }
  }

  if (open) {
    unclosed = true;
    fences.push({
      lang: open.lang,
      start: open.start,
      end: lines.length - 1,
      unclosed: true,
    });
  }

  return { headings, fences, unclosed };
}

/** 每个标题的祖先路径 */
function buildHeadingPaths(headings: Heading[]) {
  const paths = new Map<number, string>();
  const stack: Heading[] = [];

  for (const heading of headings) {
    while (stack.length && stack[stack.length - 1].level >= heading.level) {
      stack.pop();
    }
    const parent = stack.length ? paths.get(stack[stack.length - 1].line) : "";
    paths.set(
      heading.line,
      parent ? `${parent} > ${heading.text}` : heading.text,
    );
    stack.push(heading);
  }

  return paths;
}

/* ------------------------------ 切分 ------------------------------ */

function measure(lines: string[], startLine: number, endLine: number) {
  let chars = 0;
  let codeChars = 0;
  let codeBlocks = 0;
  let inFence: { char: string; len: number } | null = null;

  for (let i = startLine; i <= endLine; i++) {
    const line = lines[i] ?? "";
    chars += line.length + 1;

    if (inFence) {
      codeChars += line.length + 1;
      const close = line.match(/^\s{0,3}(`{3,}|~{3,})\s*$/);
      if (
        close &&
        close[1][0] === inFence.char &&
        close[1].length >= inFence.len
      ) {
        inFence = null;
      }
      continue;
    }

    const open = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (open) {
      codeBlocks += 1;
      codeChars += line.length + 1;
      inFence = { char: open[1][0], len: open[1].length };
    }
  }

  const textChars = Math.max(0, chars - codeChars);
  return {
    chars,
    codeChars,
    codeBlocks,
    estTokens: Math.round(
      textChars / TEXT_CHARS_PER_TOKEN + codeChars / CODE_CHARS_PER_TOKEN,
    ),
  };
}

function makeSection(
  lines: string[],
  startLine: number,
  endLine: number,
  heading: Heading | null,
  paths: Map<number, string>,
): RawSection {
  const measured = measure(lines, startLine, endLine);
  return {
    heading: heading?.text ?? "(前言)",
    headingRef: heading,
    level: heading?.level ?? 0,
    headingPath: paths.get(startLine) ?? "",
    text: lines.slice(startLine, endLine + 1).join("\n"),
    startLine,
    endLine,
    ...measured,
  };
}

function buildSections(
  lines: string[],
  headings: Heading[],
  level: number,
  paths: Map<number, string>,
): RawSection[] {
  // 只认 ATX 标题（`#` 开头）。EULA / 合同这类文本常用 Setext
  // （正文行下面跟一行 `---`），那是正文分隔而不是章节，不能拿它切。
  const atx = headings.filter((h) => !h.setext);
  const cuts = atx.filter((h) => h.level <= level);
  if (cuts.length === 0) {
    // 没有 `#` 标题：整篇作为一节（EULA、纯文本都走这里）
    return [makeSection(lines, 0, lines.length - 1, null, paths)];
  }

  const sections: RawSection[] = [];
  if (cuts[0].line > 0) {
    sections.push(makeSection(lines, 0, cuts[0].line - 1, null, paths));
  }
  for (let i = 0; i < cuts.length; i++) {
    const from = cuts[i].line;
    const to = (i + 1 < cuts.length ? cuts[i + 1].line : lines.length) - 1;
    sections.push(makeSection(lines, from, to, cuts[i], paths));
  }
  return sections;
}

/** 超长节：用更深一级标题继续切；没有更深标题就保留整段 */
function expandOversized(
  lines: string[],
  headings: Heading[],
  sections: RawSection[],
  maxChars: number,
  paths: Map<number, string>,
): RawSection[] {
  return sections.flatMap((section) => {
    if (section.chars <= maxChars) return [section];
    const deeper = subdivide(lines, headings, section, maxChars, paths);
    return deeper ?? [section];
  });
}

function subdivide(
  lines: string[],
  headings: Heading[],
  parent: RawSection,
  maxChars: number,
  paths: Map<number, string>,
): RawSection[] | null {
  // 同 buildSections：只用 ATX 标题切，Setext 的 `---` 不算标题
  const inside = headings.filter(
    (h) =>
      !h.setext &&
      h.line > parent.startLine &&
      h.line <= parent.endLine &&
      h.level > parent.level,
  );
  if (inside.length === 0) return null;

  const deeperLevel = Math.min(...inside.map((h) => h.level));
  const cuts = inside.filter((h) => h.level === deeperLevel);
  const parentHeading: Heading = {
    level: parent.level,
    text: parent.heading,
    line: parent.startLine,
  };

  const sections: RawSection[] = [
    makeSection(
      lines,
      parent.startLine,
      cuts[0].line - 1,
      parentHeading,
      paths,
    ),
  ];
  for (let i = 0; i < cuts.length; i++) {
    const from = cuts[i].line;
    const to =
      (i + 1 < cuts.length ? cuts[i + 1].line : parent.endLine + 1) - 1;
    sections.push(makeSection(lines, from, to, cuts[i], paths));
  }

  return sections.flatMap((section) =>
    section.chars <= maxChars
      ? [section]
      : subdivide(lines, headings, section, maxChars, paths) ?? [section],
  );
}

/** 合并只有标题没有正文的小节（反复合并直到没有过小的节） */
function mergeTiny(
  lines: string[],
  sections: RawSection[],
  minChars: number,
  paths: Map<number, string>,
): RawSection[] {
  if (!minChars || minChars <= 0) return sections;

  let list = sections.slice();
  for (let guard = 0; guard < 50; guard++) {
    if (list.length <= 1) break;
    const index = list.findIndex((s) => s.level > 0 && s.chars < minChars);
    if (index < 0) break;

    const tiny = list[index];
    if (index + 1 < list.length) {
      const next = list[index + 1];
      list = [
        ...list.slice(0, index),
        combine(lines, tiny, next, tiny, paths),
        ...list.slice(index + 2),
      ];
    } else {
      const prev = list[index - 1];
      list = [
        ...list.slice(0, index - 1),
        combine(lines, prev, tiny, prev, paths),
      ];
    }
  }
  return list;
}

function combine(
  lines: string[],
  from: RawSection,
  to: RawSection,
  primary: RawSection,
  paths: Map<number, string>,
): RawSection {
  return makeSection(
    lines,
    from.startLine,
    to.endLine,
    {
      level: primary.level,
      text: primary.heading,
      line: from.startLine,
    },
    paths,
  );
}

/**
 * 在代码围栏边界处安全截断一段文本（不会切在代码块内部）。
 * @param section 要截断的节
 * @param maxTokens token 预算
 * @returns 截断后的文本（可能等于原文）
 */
export function truncateSectionSafe(
  section: MarkdownSection,
  maxTokens: number,
): { text: string; truncated: boolean } {
  if (section.estTokens <= maxTokens) {
    return { text: section.text, truncated: false };
  }

  const lines = section.text.split("\n");
  const ratio = maxTokens / section.estTokens;
  const roughIndex = Math.max(1, Math.floor(lines.length * ratio));

  // 从估算位置往前找最近的“围栏边界”（一行是封闭的 ``` 或 ~~~）
  let inFence = false;
  const boundaries: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s{0,3}(`{3,}|~{3,})\s*$/.test(lines[i])) {
      inFence = !inFence;
      if (!inFence) boundaries.push(i);
    }
  }

  const candidate = boundaries.filter((i) => i < roughIndex).pop();
  const cutIndex = candidate ?? roughIndex;
  return {
    text: lines.slice(0, cutIndex + 1).join("\n"),
    truncated: true,
  };
}
