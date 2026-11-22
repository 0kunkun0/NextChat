import { filterValidSectionIds } from "../app/utils/knowledge/affected";

/**
 * 勾选里混着失效 id（文档被删 / 重新导入过）时，要能干净地剔掉。
 *
 * 之前的表现：选了 96 节，界面只显示 81 节——15 个 id 在新的知识库索引里
 * 已经不存在了，却没有任何提示。
 */
describe("filterValidSectionIds", () => {
  test("保留有效 id，剔除失效 id（保持原顺序）", () => {
    const { kept, removed } = filterValidSectionIds(
      ["a-1", "dead-9", "b-2", "dead-10"],
      new Set(["a-1", "b-2", "c-3"]),
    );
    expect(kept).toEqual(["a-1", "b-2"]);
    expect(removed).toEqual(["dead-9", "dead-10"]);
  });

  test("全部有效时不丢东西", () => {
    const { kept, removed } = filterValidSectionIds(
      ["a-1", "a-2"],
      ["a-1", "a-2", "z-9"],
    );
    expect(kept).toEqual(["a-1", "a-2"]);
    expect(removed).toEqual([]);
  });

  test("全部失效时返回空", () => {
    const { kept, removed } = filterValidSectionIds(["x-1"], []);
    expect(kept).toEqual([]);
    expect(removed).toEqual(["x-1"]);
  });
});
