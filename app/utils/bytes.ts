/**
 * 类型化数组 → Web API 需要的 `BufferSource`。
 *
 * 为什么需要这个转换：
 *   TypeScript 5.7 起把类型化数组改成泛型（`Uint8Array<ArrayBufferLike>`），
 *   而 `CompressionStream` / `DecompressionStream` / WebCrypto 的参数要求
 *   `BufferSource`，也就是底层必须是 `ArrayBuffer`（不含 `SharedArrayBuffer`）。
 *   于是 `writer.write(bytes)` 会在新编辑器里报：
 *     “类型 Uint8Array<ArrayBufferLike> 的参数不能赋给类型 BufferSource 的参数”。
 *
 * 运行时本来就是同一块内存，这里只做类型层面的收敛：
 * 老版本 TS（< 5.7，本仓库锁的 5.2.2）和新版本都能编译。
 */
export function toBufferSource(bytes: Uint8Array): BufferSource {
  return bytes as unknown as BufferSource;
}
