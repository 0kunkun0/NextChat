import { webcrypto } from "crypto";
import { TextDecoder, TextEncoder } from "util";

import {
  ENC_PREFIX,
  createKdfParams,
  decryptSession,
  decryptText,
  encryptSession,
  encryptText,
  isCryptoAvailable,
  keyedHash,
  unlockAndExport,
  unlockWithPassword,
} from "../app/utils/crypto";

// jsdom 没有 WebCrypto / TextEncoder，用 Node 自带的实现顶上（算法行为一致）
beforeAll(() => {
  // jsdom 的 crypto 是只读 getter，直接赋值会被忽略，必须 defineProperty
  Object.defineProperty(globalThis, "crypto", {
    value: webcrypto,
    configurable: true,
    writable: true,
  });
  if (typeof (globalThis as any).TextEncoder === "undefined") {
    (globalThis as any).TextEncoder = TextEncoder;
  }
  if (typeof (globalThis as any).TextDecoder === "undefined") {
    (globalThis as any).TextDecoder = TextDecoder;
  }
});

const ITER = 100_000;

describe("crypto primitives", () => {
  test("encrypt / decrypt roundtrip", async () => {
    const { bundle } = await createKdfParams("correct horse", ITER);
    const cipher = await encryptText(bundle.encKey, "神秘小对话");
    expect(cipher.startsWith(ENC_PREFIX)).toBe(true);
    expect(await decryptText(bundle.encKey, cipher)).toBe("神秘小对话");
  });

  test("同一个明文每次密文都不同（随机 IV）", async () => {
    const { bundle } = await createKdfParams("pw", ITER);
    const a = await encryptText(bundle.encKey, "same text");
    const b = await encryptText(bundle.encKey, "same text");
    expect(a).not.toBe(b);
    expect(await decryptText(bundle.encKey, a)).toBe("same text");
    expect(await decryptText(bundle.encKey, b)).toBe("same text");
  });

  test("没加密的历史数据原样返回", async () => {
    const { bundle } = await createKdfParams("pw", ITER);
    expect(await decryptText(bundle.encKey, "plain legacy text")).toBe(
      "plain legacy text",
    );
  });

  test("密码错误必须解锁失败（GCM 校验值）", async () => {
    const { params } = await createKdfParams("right password", ITER);
    expect(await unlockWithPassword("right password", params)).toBeTruthy();
    expect(await unlockWithPassword("wrong password", params)).toBeNull();
  });

  test("unlockAndExport 返回可复用的密钥材料", async () => {
    const { params } = await createKdfParams("pw-2", ITER);
    const first = await unlockAndExport("pw-2", params);
    const second = await unlockAndExport("pw-2", params);
    expect(first?.material).toBeTruthy();
    expect(first?.material).toBe(second?.material);

    // 两个独立的 bundle 能互相解密（同一把密钥）
    const cipher = await encryptText(first!.bundle.encKey, "hello");
    expect(await decryptText(second!.bundle.encKey, cipher)).toBe("hello");
  });

  test("keyedHash 稳定且依赖密钥", async () => {
    const a = await createKdfParams("pw-a", ITER);
    const b = await createKdfParams("pw-b", ITER);

    const h1 = await keyedHash(a.bundle.macKey, "same json");
    const h2 = await keyedHash(a.bundle.macKey, "same json");
    const h3 = await keyedHash(a.bundle.macKey, "other json");
    const h4 = await keyedHash(b.bundle.macKey, "same json");

    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
    expect(h1).not.toBe(h4);
  });

  test("isCryptoAvailable 在 WebCrypto 存在时为 true", () => {
    expect(isCryptoAvailable()).toBe(true);
  });
});

describe("session encryption", () => {
  function makeSession() {
    return {
      id: "s1",
      topic: "91+",
      memoryPrompt: "记忆里的悄悄话",
      lastUpdate: 1,
      messages: [
        { id: "m1", role: "user", content: "神秘内容", date: "" },
        {
          id: "m2",
          role: "assistant",
          content: [
            { type: "text", text: "多模态内容" },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,xx" },
            },
          ],
          variants: [
            { content: "候选一", model: "m", date: "" },
            { content: "候选二", model: "m", date: "" },
          ],
          date: "",
        },
      ],
    } as any;
  }

  test("内容与标题加密、结构与元数据保留", async () => {
    const { bundle } = await createKdfParams("pw-session", ITER);
    const encrypted = await encryptSession(bundle, makeSession());

    // 加密后的 JSON 里不能出现任何原文
    const json = JSON.stringify(encrypted);
    for (const secret of [
      "神秘内容",
      "91+",
      "多模态内容",
      "候选一",
      "记忆里的悄悄话",
    ]) {
      expect(json).not.toContain(secret);
    }

    // 结构没变：role / id / 消息条数都在
    expect(encrypted.messages).toHaveLength(2);
    expect(encrypted.messages[0].role).toBe("user");
    expect(encrypted.messages[0].id).toBe("m1");

    // 解密后与原文完全一致（含数组内容、候选回复、标题）
    const decrypted = await decryptSession(bundle, encrypted);
    expect(decrypted).toEqual(makeSession());
  });

  test("未加密的旧数据可以混着解密", async () => {
    const { bundle } = await createKdfParams("pw-mixed", ITER);
    const session = {
      id: "s2",
      topic: "旧标题", // 明文
      messages: [
        // 明文（老数据）
        { id: "m1", role: "user", content: "旧明文", date: "" },
        // 混合：只有部分字段被加密
        {
          id: "m2",
          role: "assistant",
          content: await encryptText(bundle.encKey, "新密文"),
          date: "",
        },
      ],
    } as any;

    const decrypted = await decryptSession(bundle, session);
    expect(decrypted.topic).toBe("旧标题");
    expect(decrypted.messages[0].content).toBe("旧明文");
    expect(decrypted.messages[1].content).toBe("新密文");
  });
});
