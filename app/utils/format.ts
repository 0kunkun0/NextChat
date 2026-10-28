export function prettyObject(msg: any) {
  const obj = msg;
  if (typeof msg !== "string") {
    msg = JSON.stringify(msg, null, "  ");
  }
  if (msg === "{}") {
    return obj.toString();
  }
  if (msg.startsWith("```json")) {
    return msg;
  }
  return ["```json", msg, "```"].join("\n");
}

/**
 * 按字节把字符串切成若干片（每片不超过 maxBytes）。
 *
 * 以前是按空格切：压缩后的 base64 里没有空格，一整段会被塞进同一片，
 * 直接超过 Upstash 单请求上限；而且每次 `buf.slice(i + 1)` 都会复制剩余缓冲区，
 * 片数多时总复制量是 O(N²)。现在只编码一次、用 subarray 视图切片。
 */
export function* chunks(s: string, maxBytes = 1000 * 1000) {
  const buf = new TextEncoder().encode(s);
  const decoder = new TextDecoder("utf-8");
  let start = 0;

  while (start < buf.length) {
    let end = Math.min(start + maxBytes, buf.length);
    // 不要把一个多字节字符切成两半：退到 UTF-8 起始字节
    if (end < buf.length) {
      while (end > start && (buf[end] & 0xc0) === 0x80) {
        end -= 1;
      }
      // 单个字符就超过 maxBytes（几乎不可能），硬切
      if (end === start) end = Math.min(start + maxBytes, buf.length);
    }
    yield decoder.decode(buf.subarray(start, end));
    start = end;
  }
}

const BLANK_LINE = /^[\s\u200b\u200c\u200d]*$/;
const CODE_FENCE = /^\s*(```|~~~)/;

/**
 * 规范化“空行”：
 * - CRLF / CR → LF；
 * - 只含空白字符的行（包括全角空格 U+3000、NBSP、零宽空格等）→ 真正的空行。
 *
 * CommonMark 只把「不含任何字符的空行」当成段落分隔，模型/IME 输出的空行里
 * 经常混着全角空格或零宽字符，于是两段被并成一段、空行就“消失”了。
 * 代码块（``` / ~~~）里的内容保持原样，不做处理。
 */
export function normalizeBlankLines(text: string) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let inCodeFence = false;

  return lines
    .map((line) => {
      if (CODE_FENCE.test(line)) {
        inCodeFence = !inCodeFence;
        return line;
      }
      if (inCodeFence) return line;
      return BLANK_LINE.test(line) ? "" : line;
    })
    .join("\n");
}

/**
 * cyrb53：快速字符串哈希（53 bit），用于判断某段内容自上次上传后是否变化。
 * 不要求密码学强度，只要求同内容同结果、改一个字符结果就变。
 */
export function hashString(str: string) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;

  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }

  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);

  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
