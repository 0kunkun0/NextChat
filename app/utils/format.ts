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

export function* chunks(s: string, maxBytes = 1000 * 1000) {
  const decoder = new TextDecoder("utf-8");
  let buf = new TextEncoder().encode(s);
  while (buf.length) {
    // 整段都放得下就直接返回，别为了切分把一小段也拆成两片
    if (buf.length <= maxBytes) {
      yield decoder.decode(buf);
      return;
    }
    let i = buf.lastIndexOf(32, maxBytes + 1);
    // If no space found, try forward search
    if (i < 0) i = buf.indexOf(32, maxBytes);
    // If there's no space at all, take all
    if (i < 0) i = buf.length;
    // This is a safe cut-off point; never half-way a multi-byte
    yield decoder.decode(buf.slice(0, i + 1));
    // 切分点上的空格留在这一片末尾：读端是 chunks.join("")，
    // 原来的 `slice(i + 1)` 会把它连同空格一起丢掉，导致还原时少一个空格
    buf = buf.slice(i + 1);
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
