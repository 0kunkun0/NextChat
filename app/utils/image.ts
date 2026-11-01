/** 上传前把图片缩到这个尺寸以内：足够视觉模型识别，又能避开老设备 canvas 的内存上限 */
export const MAX_IMAGE_DIMENSION = 1600;

/**
 * 按最长边等比缩放。
 * 老 iPhone（内存小）把整张原图丢进 canvas 很容易被系统杀掉，
 * 所以先算出缩放后的宽高再绘制。
 */
export function fitImageSize(
  width: number,
  height: number,
  maxDimension = MAX_IMAGE_DIMENSION,
) {
  const w = Math.max(1, Math.round(width) || 1);
  const h = Math.max(1, Math.round(height) || 1);
  const longest = Math.max(w, h);

  if (longest <= maxDimension) {
    return { width: w, height: h };
  }

  const scale = maxDimension / longest;
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  };
}
