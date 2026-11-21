#!/usr/bin/env node
/**
 * Markdown 分块预览（RAG P0 校验工具）
 *
 * 规则（和 RAG 方案保持一致）：
 *   - 按 Markdown 标题切分，默认切到 H3（`--level` 可调）
 *   - **代码围栏内绝不切分**：``` 或 ~~~ 成对之间整块保留
 *   - 某个 section 超过 `--max-chars`（默认 20000 字）时，若它内部还有更深的标题，
 *     就用更深的那一级再切；没有更深标题则整段保留并标记 oversized
 *   - 输出分块报告：每节的标题路径、字数、估算 token、代码块数量、是否超长
 *   - 附带完整性校验：没有任何切点落在代码围栏内部
 *
 * 用法：
 *   node scripts/md-chunk-preview.mjs docs/mod0.md docs/mod1.md
 *   node scripts/md-chunk-preview.mjs docs/*.md --level 2 --max-chars 8000
 *   node scripts/md-chunk-preview.mjs docs/mod0.md --out report.md
 *   node scripts/md-chunk-preview.mjs docs/mod0.md --json > chunks.json
 *   node scripts/md-chunk-preview.mjs docs/mod0.md --show 3      # 打印第 3 节全文
 *
 * 零依赖，Node 18+。
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const USAGE = `
用法: node scripts/md-chunk-preview.mjs <file.md> [more.md ...] [options]

选项:
  --level <1-6>       切分用的标题层级，默认 3
  --max-chars <n>     单节字数软上限，默认 20000
  --min-chars <n>     小节合并阈值：小于 n 字的节并入下一节，默认 0（不合并）
  --limit <n>         列表里最多显示多少节，默认 60（0 = 全部）
  --show <n>          打印第 n 节的完整内容（用于检查代码块是否完整）
  --out <path>        把报告写到文件
  --json              以 JSON 输出所有分块（便于二次处理）
  --quiet             只输出汇总，不列明细
  -h, --help          显示帮助
`.trim();

/* ------------------------------ 参数解析 ------------------------------ */

function parseArgs(argv) {
  const options = {
    level: 3,
    maxChars: 20000,
    minChars: 0,
    limit: 60,
    show: 0,
    out: "",
    json: false,
    quiet: false,
    help: false,
  };
  const files = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--") && /[*?]/.test(arg)) {
      files.push(...expandGlob(arg));
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      files.push(arg);
      continue;
    }

    const eq = arg.indexOf("=");
    const key = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    const inline = eq >= 0 ? arg.slice(eq + 1) : undefined;
    const next = () => (inline !== undefined ? inline : argv[++i]);

    switch (key) {
      case "level":
        options.level = clampNumber(next(), 1, 6, 3);
        break;
      case "max-chars":
        options.maxChars = Math.max(500, Number(next()) || 20000);
        break;
      case "min-chars":
        options.minChars = Math.max(0, Number(next()) || 0);
        break;
      case "limit":
        options.limit = Math.max(0, Number(next()) || 0);
        break;
      case "show":
        options.show = Math.max(0, Number(next()) || 0);
        break;
      case "out":
        options.out = next() ?? "";
        break;
      case "json":
        options.json = true;
        break;
      case "quiet":
        options.quiet = true;
        break;
      default:
        console.error(`未知选项: ${arg}`);
        options.help = true;
    }
  }

  return { options, files };
}

/**
 * 展开通配符（PowerShell 不会替原生程序展开 glob，所以自己来）。
 * 支持 `*`、`?`、`**`（匹配任意层级）。
 * @param {string} pattern 例如 `docs/*.md`、`docs/**\/*.md`
 * @returns {string[]} 匹配到的路径（绝对路径）
 */
function expandGlob(pattern) {
  const abs = resolve(pattern);
  const wildcard = abs.search(/[*?]/);
  const sepIndex = Math.max(
    abs.lastIndexOf("/", wildcard),
    abs.lastIndexOf("\\", wildcard),
  );
  const dir = sepIndex > 0 ? abs.slice(0, sepIndex) : abs;
  // Windows 下剩下的模式里还带着反斜杠，统一成正斜杠再转正则
  const glob = (sepIndex > 0 ? abs.slice(sepIndex + 1) : "").replace(
    /\\/g,
    "/",
  );
  if (!glob) return [abs];

  const regex = globToRegExp(glob);
  let entries = [];
  try {
    entries = readdirSync(dir, { recursive: true });
  } catch {
    return [];
  }

  return entries
    .map((entry) => String(entry).replace(/\\/g, "/"))
    .filter((relative) => regex.test(relative))
    .map((relative) => resolve(dir, relative));
}

function globToRegExp(glob) {
  let out = "^";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // `**` 任意层级
        out += ".*";
        i += 1;
        if (glob[i + 1] === "/") i += 1;
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  out += "$";
  return new RegExp(out, "i");
}
function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/* ------------------------------ 结构扫描 ------------------------------ */

/**
 * 扫描一行范围内的结构：围栏、标题（ATX + Setext）、front matter。
 * @returns {{ headings: Array, fences: Array, frontMatter: object, unclosed: boolean }}
 */
function scan(lines) {
  const headings = [];
  const fences = [];
  let frontMatter = null;
  let unclosed = false;

  // YAML front matter：文件开头 --- ... ---
  let start = 0;
  if (lines[0]?.trim() === "---") {
    for (let i = 1; i < Math.min(lines.length, 200); i++) {
      if (lines[i].trim() === "---") {
        frontMatter = { start: 0, end: i };
        start = i + 1;
        break;
      }
    }
  }

  let open = null; // { char, len, lang, start }

  for (let i = start; i < lines.length; i++) {
    const line = lines[i];

    if (open) {
      // 关闭围栏：同一种字符，长度不短于开启的那条
      const close = line.match(/^\s{0,3}(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === open.char && close[1].length >= open.len) {
        fences.push({
          lang: open.lang,
          start: open.start,
          end: i,
          lines: i - open.start + 1,
        });
        open = null;
      }
      continue;
    }

    const openMatch = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (openMatch) {
      open = {
        char: openMatch[1][0],
        len: openMatch[1].length,
        lang: (openMatch[2] ?? "").trim().split(/\s+/)[0] ?? "",
        start: i,
      };
      continue;
    }

    // ATX 标题
    const atx = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (atx) {
      headings.push({
        level: atx[1].length,
        text: atx[2].trim(),
        line: i,
        setext: false,
      });
      continue;
    }

    // Setext 标题：文字行 + 下一行 === 或 ---（且不能是空行开头的分隔线）
    const underline = lines[i + 1];
    if (line.trim() && !/^\s{0,3}(`{3,}|~{3,})/.test(line) && underline) {
      const m = underline.match(/^\s{0,3}(=+|-{2,})\s*$/);
      if (m) {
        headings.push({
          level: m[1][0] === "=" ? 1 : 2,
          text: line.trim(),
          line: i,
          setext: true,
          underline: i + 1,
        });
        i++;
        continue;
      }
    }
  }

  // 未闭合的围栏也要记账：否则「围栏数」和「代码块数」会对不上
  if (open) {
    unclosed = true;
    fences.push({
      lang: open.lang,
      start: open.start,
      end: lines.length - 1,
      lines: lines.length - open.start,
      unclosed: true,
    });
  }

  return { headings, fences, frontMatter, unclosed };
}

/* ------------------------------ 分块 ------------------------------ */

/**
 * 计算每个标题的祖先路径（"A > B > C"）。
 * @param {Array} headings 按出现顺序排列的标题
 */
function buildHeadingPaths(headings) {
  const paths = new Map();
  const stack = [];

  for (const heading of headings) {
    while (stack.length && stack[stack.length - 1].level >= heading.level) {
      stack.pop();
    }
    const parentPath = stack.length
      ? paths.get(stack[stack.length - 1].line)
      : "";
    const path = parentPath ? `${parentPath} > ${heading.text}` : heading.text;
    paths.set(heading.line, path);
    stack.push(heading);
  }

  return paths;
}

const CODE_CHARS_PER_TOKEN = 3.5;
const TEXT_CHARS_PER_TOKEN = 2.2;

/**
 * 统计一段文本里的代码块字数（围栏内）与代码块数量。
 * @param {string[]} lines 文件的全部行
 */
function measure(lines, startLine, endLine) {
  let chars = 0;
  let codeChars = 0;
  let codeBlocks = 0;
  let inFence = null;

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
      inFence = { char: open[1][0], len: open[1].length };
      codeChars += line.length + 1;
    }
  }

  const textChars = Math.max(0, chars - codeChars);
  const estTokens = Math.round(
    textChars / TEXT_CHARS_PER_TOKEN + codeChars / CODE_CHARS_PER_TOKEN,
  );

  return { chars, codeChars, codeBlocks, estTokens };
}

/**
 * 在给定行区间内，用「比 splitLevel 更深的标题」继续切分。
 * @returns {Array|null} 若没有更深的标题则返回 null（调用方保留整段）
 */
/**
 * 在给定 section 内部，用「比它更深一级的标题」继续切分。
 *
 * 首段（第一个更深标题之前的内容，通常只有父标题那一行）沿用父标题，
 * 否则会出现一节叫「(前言)」的怪东西。
 *
 * @returns {Array|null} 内部没有更深标题时返回 null（调用方保留整段）
 */
function subdivide(lines, headings, parent, maxChars) {
  const inside = headings.filter(
    (h) =>
      h.line > parent.startLine &&
      h.line <= parent.endLine &&
      h.level > (parent.level ?? 0),
  );
  if (inside.length === 0) return null;

  const deeperLevel = Math.min(...inside.map((h) => h.level));
  const cuts = inside.filter((h) => h.level === deeperLevel);
  const parentHeading = {
    level: parent.level,
    text: parent.heading,
    line: parent.startLine,
  };

  const sections = [
    makeSection(lines, parent.startLine, cuts[0].line - 1, parentHeading),
  ];

  for (let i = 0; i < cuts.length; i++) {
    const from = cuts[i].line;
    const to =
      (i + 1 < cuts.length ? cuts[i + 1].line : parent.endLine + 1) - 1;
    sections.push(makeSection(lines, from, to, cuts[i]));
  }

  // 仍然超长的继续往下一级切
  return sections.flatMap((section) => {
    if (section.chars <= maxChars) return [section];
    const deeper = subdivide(lines, headings, section, maxChars);
    return deeper ? deeper : [{ ...section, oversized: true }];
  });
}
function makeSection(lines, startLine, endLine, heading) {
  const { chars, codeChars, codeBlocks, estTokens } = measure(
    lines,
    startLine,
    endLine,
  );
  return {
    level: heading ? heading.level : 0,
    heading: heading ? heading.text : "(前言)",
    startLine,
    endLine,
    chars,
    codeChars,
    codeBlocks,
    estTokens,
    oversized: false,
    depth: 0,
    text: lines.slice(startLine, endLine + 1).join("\n"),
  };
}

/**
 * 按标题层级切分整个文档。
 */
function chunkDocument(lines, headings, options) {
  const cuts = headings.filter((h) => h.level <= options.level);
  const sections = [];

  if (cuts.length === 0) {
    const whole = makeSection(lines, 0, lines.length - 1, null);
    whole.oversized = whole.chars > options.maxChars;
    return [whole];
  }

  if (cuts[0].line > 0) {
    sections.push(makeSection(lines, 0, cuts[0].line - 1, null));
  }
  for (let i = 0; i < cuts.length; i++) {
    const from = cuts[i].line;
    const to = (i + 1 < cuts.length ? cuts[i + 1].line : lines.length) - 1;
    sections.push(makeSection(lines, from, to, cuts[i]));
  }

  // 超长章节：尝试用更深标题再切
  const expanded = sections.flatMap((section) => {
    if (section.chars <= options.maxChars) return [section];
    const deeper = subdivide(lines, headings, section, options.maxChars);
    return deeper ? deeper : [{ ...section, oversized: true }];
  });

  return mergeTinySections(expanded, lines, options.minChars);
}

/**
 * 小于 `minChars` 的节并入下一节（没有下一节时并入上一节）。
 *
 * 很多文档的 H2/H3 只是一个标题、正文全在下一级小节里，单独成节既检索不到
 * 也浪费一个注入位；合并后按「父标题 + 内容」作为整体。
 */
function mergeTinySections(sections, lines, minChars) {
  if (!minChars || minChars <= 0) return sections;

  let list = sections.slice();
  // 反复合并直到没有过小的节（上限 50 轮，防止病态输入死循环）
  for (let guard = 0; guard < 50; guard++) {
    if (list.length <= 1) break;
    const index = list.findIndex((s) => s.level > 0 && s.chars < minChars);
    if (index < 0) break;

    const tiny = list[index];
    if (index + 1 < list.length) {
      // 优先并入下一节（同一父级里的兄弟）
      const next = list[index + 1];
      const combined = combineSections(lines, tiny, next, tiny);
      list = [...list.slice(0, index), combined, ...list.slice(index + 2)];
    } else {
      // 最后一节：并入上一节
      const prev = list[index - 1];
      const combined = combineSections(lines, prev, tiny, prev);
      list = [...list.slice(0, index - 1), combined];
    }
  }
  return list;
}

/** 把两个相邻区间合并成一个节，标题沿用 primary 那一个 */
function combineSections(lines, from, to, primary) {
  const combined = makeSection(lines, from.startLine, to.endLine, {
    level: primary.level,
    text: primary.heading,
    line: from.startLine,
  });
  combined.mergedFrom = (from.mergedFrom ?? 1) + (to.mergedFrom ?? 1);
  return combined;
}
/* ------------------------------ 报告 ------------------------------ */

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.floor((p / 100) * sorted.length),
  );
  return sorted[index];
}

function formatNumber(n) {
  return n.toLocaleString("en-US");
}

function truncate(text, max = 60) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * 检查是否有切点落在代码围栏内部（必须为 0）。
 */
function findBadCuts(sections, fences) {
  const bad = [];
  for (const section of sections) {
    if (section.startLine === 0) continue;
    for (const fence of fences) {
      if (fence.start < section.startLine && section.startLine <= fence.end) {
        bad.push({ section: section.heading, line: section.startLine + 1 });
      }
    }
  }
  return bad;
}

function renderReport(files, options) {
  const out = [];
  const jsonSections = [];

  out.push(`# Markdown 分块报告`);
  out.push("");
  out.push(
    `切分层级: H${options.level} · 单节软上限: ${formatNumber(
      options.maxChars,
    )} 字 · 文件数: ${files.length}`,
  );
  out.push("");
  out.push(
    "| 文件 | 行数 | 字数 | 节数 | 代码块 | 代码字数 | p50 字数 | p90 字数 | 最长 | 超长节 | 坏切点 |",
  );
  out.push(
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  );

  for (const file of files) {
    const chars = file.sections.reduce((sum, s) => sum + s.chars, 0);
    const sizes = file.sections.map((s) => s.chars);
    const codeBlocks = file.sections.reduce((sum, s) => sum + s.codeBlocks, 0);
    const codeChars = file.sections.reduce((sum, s) => sum + s.codeChars, 0);
    const bad = findBadCuts(file.sections, file.fences);

    out.push(
      `| ${file.name} | ${formatNumber(file.lineCount)} | ${formatNumber(
        chars,
      )} | ${file.sections.length} | ${codeBlocks} | ${formatNumber(
        codeChars,
      )} | ${formatNumber(percentile(sizes, 50))} | ${formatNumber(
        percentile(sizes, 90),
      )} | ${formatNumber(Math.max(...sizes))} | ${
        file.sections.filter((s) => s.oversized).length
      } | ${bad.length} |`,
    );
  }

  for (const file of files) {
    const bad = findBadCuts(file.sections, file.fences);
    out.push("");
    out.push(`## ${file.name}`);
    out.push("");
    out.push(`- 路径: ${file.path}`);
    out.push(`- 行数: ${formatNumber(file.lineCount)}`);
    const unclosedFences = file.fences.filter((f) => f.unclosed).length;
    const fenceLangs = new Map();
    for (const fence of file.fences) {
      const lang = fence.lang || "(无标签)";
      fenceLangs.set(lang, (fenceLangs.get(lang) ?? 0) + 1);
    }
    out.push(
      `- 代码块: ${file.fences.length} 个${
        unclosedFences > 0
          ? `（⚠ ${unclosedFences} 个未闭合，文件末尾就断了）`
          : "（全部闭合）"
      }`,
    );
    if (file.fences.length > 0) {
      out.push(
        `- 代码块语言: ${[...fenceLangs.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([lang, count]) => `${lang}×${count}`)
          .join(" · ")}`,
      );
    }
    out.push(
      `- 完整性: ${
        bad.length === 0
          ? "✅ 没有切点落在代码围栏内部"
          : `❌ 有 ${bad.length} 处切点落在围栏内: ${bad
              .map((b) => `${b.section}@L${b.line}`)
              .join(", ")}`
      }`,
    );

    if (file.sections.some((s) => s.oversized)) {
      out.push(
        `- ⚠ 超长节（>${formatNumber(
          options.maxChars,
        )} 字且没有更深标题可切）: ${file.sections
          .filter((s) => s.oversized)
          .map((s) => `「${s.heading}」${formatNumber(s.chars)} 字`)
          .join("、")}`,
      );
    }

    // --show：只打印指定那一节的全文，不刷大纲和明细
    if (options.show > 0) {
      const section = file.sections[options.show - 1];
      out.push("");
      if (!section) {
        out.push(
          `### ⚠ 第 ${options.show} 节不存在（共 ${file.sections.length} 节）`,
        );
      } else {
        out.push(
          `### 第 ${options.show} 节全文：${
            section.headingPath || section.heading
          }`,
        );
        out.push("");
        out.push(
          `层级 H${section.level} · ${formatNumber(
            section.chars,
          )} 字 · ≈${formatNumber(section.estTokens)} token · 代码块 ${
            section.codeBlocks
          } · L${section.startLine + 1}-L${section.endLine + 1}`,
        );
        out.push("");
        out.push("````markdown");
        out.push(section.text);
        out.push("````");
      }
      jsonSections.push({
        file: file.path,
        name: file.name,
        lineCount: file.lineCount,
        fences: file.fences.length,
        sections: [],
      });
      continue;
    }

    out.push("");
    out.push("### 大纲");
    out.push("");
    out.push("```text");
    for (const section of file.sections) {
      const indent = "  ".repeat(Math.max(0, section.level - 1));
      const flag = section.oversized ? " ⚠超长" : "";
      out.push(
        `${indent}${section.level === 0 ? "·" : "#".repeat(section.level)} ${
          section.heading
        }  (${formatNumber(section.chars)}字${flag})`,
      );
    }
    out.push("```");

    if (!options.quiet) {
      out.push("");
      out.push("### 分节明细");
      out.push("");
      out.push("| # | 层级 | 标题 | 字数 | ≈token | 代码块 | 行范围 | 预览 |");
      out.push("| ---: | --- | --- | ---: | ---: | ---: | --- | --- |");
      const shown =
        options.limit > 0
          ? file.sections.slice(0, options.limit)
          : file.sections;
      shown.forEach((section, index) => {
        const preview = truncate(
          section.text
            .split("\n")
            .slice(1)
            .join(" ")
            .replace(/<[^>]+>/g, " ")
            .trim(),
        );
        out.push(
          `| ${index + 1} | H${section.level} | ${truncate(
            section.heading,
            40,
          )} | ${formatNumber(section.chars)} | ${formatNumber(
            section.estTokens,
          )} | ${section.codeBlocks} | L${section.startLine + 1}-L${
            section.endLine + 1
          } | ${preview} |`,
        );
      });
      if (options.limit > 0 && file.sections.length > options.limit) {
        out.push("");
        out.push(
          `… 还有 ${
            file.sections.length - options.limit
          } 节未显示（--limit 0 显示全部）`,
        );
      }
    }

    if (options.show > 0) {
      const section = file.sections[options.show - 1];
      out.push("");
      if (!section) {
        out.push(`### ⚠ 第 ${options.show} 节不存在`);
      } else {
        out.push(`### 第 ${options.show} 节全文`);
        out.push("");
        out.push("````markdown");
        out.push(section.text);
        out.push("````");
      }
    }

    jsonSections.push({
      file: file.path,
      name: file.name,
      lineCount: file.lineCount,
      fences: file.fences.length,
      sections: file.sections.map((section) => ({
        heading: section.heading,
        level: section.level,
        startLine: section.startLine + 1,
        endLine: section.endLine + 1,
        chars: section.chars,
        codeChars: section.codeChars,
        codeBlocks: section.codeBlocks,
        estTokens: section.estTokens,
        oversized: section.oversized,
      })),
    });
  }

  return { report: out.join("\n"), json: jsonSections, files };
}

/* ------------------------------ 主流程 ------------------------------ */

function main() {
  const { options, files: paths } = parseArgs(process.argv.slice(2));

  if (options.help || paths.length === 0) {
    console.log(USAGE);
    process.exit(options.help ? 0 : 1);
  }

  const files = [];
  for (const rawPath of paths) {
    const path = resolve(rawPath);
    let content;
    try {
      content = readFileSync(path, "utf8");
    } catch (e) {
      console.error(`跳过 ${rawPath}: ${e.message}`);
      continue;
    }

    const normalized = content.replace(/\r\n?/g, "\n");
    const lines = normalized.split("\n");
    const { headings, fences, frontMatter, unclosed } = scan(lines);
    const sections = chunkDocument(lines, headings, options);
    const pathsMap = buildHeadingPaths(headings);
    for (const section of sections) {
      section.headingPath =
        pathsMap.get(section.startLine) ?? section.heading ?? "";
    }

    files.push({
      path,
      name: basename(path),
      lineCount: lines.length,
      sections,
      fences,
      frontMatter,
      unclosed,
    });
  }

  if (files.length === 0) {
    console.error("没有可读取的文件");
    process.exit(1);
  }

  const { report, json } = renderReport(files, options);

  if (options.json) {
    console.log(JSON.stringify(json, null, 2));
    return;
  }

  if (options.out) {
    writeFileSync(resolve(options.out), report, "utf8");
    console.log(`报告已写入 ${options.out}`);
    return;
  }

  console.log(report);
}

main();
