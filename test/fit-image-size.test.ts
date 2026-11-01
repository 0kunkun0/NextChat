import { fitImageSize } from "../app/utils/image";

describe("fitImageSize", () => {
  test("keeps small images untouched", () => {
    expect(fitImageSize(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fitImageSize(1600, 900)).toEqual({ width: 1600, height: 900 });
  });

  test("scales landscape photos by the longest side", () => {
    expect(fitImageSize(4032, 3024)).toEqual({ width: 1600, height: 1200 });
  });

  test("scales portrait photos by the longest side", () => {
    expect(fitImageSize(3024, 4032)).toEqual({ width: 1200, height: 1600 });
  });

  test("never returns zero-sized dimensions", () => {
    const result = fitImageSize(10000, 1);
    expect(result.width).toBe(1600);
    expect(result.height).toBe(1);
  });

  test("handles invalid input", () => {
    expect(fitImageSize(0, 0)).toEqual({ width: 1, height: 1 });
    expect(fitImageSize(Number.NaN, 100)).toEqual({ width: 1, height: 100 });
  });
});
