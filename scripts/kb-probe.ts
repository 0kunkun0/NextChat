/**
 * 用真实文档跑一次「切分 → 建索引 → 检索」，验证检索链路。
 * 运行：node --experimental-strip-types scripts/kb-probe.ts <query> [files...]
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";

import { chunkMarkdown } from "../app/utils/knowledge/chunker";
import { tokenizeQuery } from "../app/utils/knowledge/tokenize";
import {
  buildIndex,
  search,
  type KnowledgeChunk,
} from "../app/utils/knowledge/retrieval";

const args = process.argv.slice(2);
const query = args[0] ?? "怎么设置超时";
const fileArgs = args.slice(1);

const chunks: KnowledgeChunk[] = [];
let totalSections = 0;
let totalChars = 0;

for (const path of fileArgs) {
  const text = readFileSync(path, "utf8");
  const { sections, stats } = chunkMarkdown(text);
  totalSections += sections.length;
  totalChars += stats.chars;
  sections.forEach((section, index) => {
    chunks.push({
      ...section,
      id: `${basename(path)}-${index}`,
      docId: basename(path),
      docName: basename(path),
    });
  });
}

console.log(
  `docs=${fileArgs.length} sections=${totalSections} chunks=${chunks.length} chars=${totalChars}`,
);
console.log("query tokens:", tokenizeQuery(query).slice(0, 30));

let index = buildIndex(chunks);
let hits = search(index, query, { minChars: 200, candidates: 8 });
console.log(`hits=${hits.length} tokens=${hits.reduce((s, h) => s + h.estTokens, 0)}`);
for (const hit of hits.slice(0, 5)) {
  console.log(
    `  ${hit.score.toFixed(2)}  ${hit.chunk.docName} :: ${hit.chunk.headingPath.slice(0, 80)} (${hit.chunk.chars}字)`,
  );
}

if (hits.length === 0) {
  // 诊断：有多少节至少包含一个 query token
  const tokens = tokenizeQuery(query);
  let partial = 0;
  for (const chunk of chunks) {
    const text = `${chunk.headingPath}\n${chunk.text}`;
    if (tokens.some((token) => text.includes(token))) partial += 1;
  }
  console.log(`诊断：包含任意 query token 的节 = ${partial}/${chunks.length}`);

  // 去掉 minChars 再试
  const loose = search(index, query, { minChars: 0, candidates: 8 });
  console.log(`不限制 minChars 时 hits=${loose.length}`);
  for (const hit of loose.slice(0, 5)) {
    console.log(
      `  ${hit.score.toFixed(2)}  ${hit.chunk.docName} :: ${hit.chunk.headingPath.slice(0, 80)} (${hit.chunk.chars}字)`,
    );
  }
}
