import { isVisionModel } from "../app/utils";

/**
 * 本 fork 故意让 isVisionModel 恒为 true：
 * 有些模型其实支持多模态，但内置的正则列表不漏出来，导致图片上传按钮不显示，
 * 所以这里直接全部放开（自用）。这个测试用来固定这个有意为之的行为。
 */
describe("isVisionModel", () => {
  test("always returns true in this fork", () => {
    expect(isVisionModel("gpt-4-vision")).toBe(true);
    expect(isVisionModel("claude-3-opus")).toBe(true);
    expect(isVisionModel("unrelated-model")).toBe(true);
  });
});
