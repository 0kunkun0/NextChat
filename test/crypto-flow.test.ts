import { resolveKeySource, sameKdfParams } from "../app/utils/crypto-params";

/**
 * 每台设备各自「启用加密」会生成各自的 salt：
 * 同一个密码派生出的钥匙不同，云端数据只能用**云端参数**派生出来的钥匙解开。
 *
 * 之前的 bug：ensureBundle 只看内存里有没有钥匙就直接用，
 * 于是另一台设备（或本机重新启用过加密）下载时必然解密失败 →
 * 提示「密码不正确」，必须先关掉本地加密再输密码才行。
 */
function params(salt: string, iter = 600000) {
  return { v: 1, kdf: "PBKDF2-SHA256", iter, salt, check: "x" } as any;
}

describe("sameKdfParams", () => {
  test("salt 和迭代次数都一致才算同一把钥匙", () => {
    expect(sameKdfParams(params("a"), params("a"))).toBe(true);
    expect(sameKdfParams(params("a"), params("b"))).toBe(false);
    expect(sameKdfParams(params("a", 100), params("a", 200))).toBe(false);
    expect(sameKdfParams(null, params("a"))).toBe(false);
    expect(sameKdfParams(params("a"), undefined)).toBe(false);
  });
});

describe("resolveKeySource", () => {
  test("云端没加密：不需要钥匙", () => {
    expect(
      resolveKeySource({ cloudParams: null, activeParams: params("local") }),
    ).toBe("none");
  });

  test("本机钥匙与云端参数一致：直接用，不弹窗", () => {
    expect(
      resolveKeySource({
        cloudParams: params("salt-1"),
        activeParams: params("salt-1"),
        rememberedParams: null,
      }),
    ).toBe("active");
  });

  test("内存里没有、但记住的钥匙与云端一致：用记住的", () => {
    expect(
      resolveKeySource({
        cloudParams: params("salt-1"),
        activeParams: null,
        rememberedParams: params("salt-1"),
      }),
    ).toBe("remembered");
  });

  test("本机是另一套参数（以前会直接用错钥匙 → 提示密码不正确）", () => {
    expect(
      resolveKeySource({
        cloudParams: params("salt-cloud"),
        activeParams: params("salt-local"),
        rememberedParams: params("salt-local"),
      }),
    ).toBe("prompt");
  });

  test("迭代次数不同也算不同钥匙", () => {
    expect(
      resolveKeySource({
        cloudParams: params("salt-1", 600000),
        activeParams: params("salt-1", 100000),
      }),
    ).toBe("prompt");
  });
});
