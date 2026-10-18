/** 数值小工具：分段线性映射、区间裁剪、平滑。 */

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const round = (v, digits = 1) => {
  const p = 10 ** digits;
  return Math.round(v * p) / p;
};

/** 取模，永远返回非负数。 */
export const mod = (a, n) => ((a % n) + n) % n;

/**
 * 分段线性插值——整个评分模型的骨架。
 * points 必须按 x 升序，形如 [[x0, y0], [x1, y1], ...]；超出两端取端点值。
 * 用线性而不是样条，是为了让"为什么给这个分"一眼能看懂、也方便手调。
 */
export function ramp(x, points) {
  if (x == null || Number.isNaN(x)) return points[0][1];
  const n = points.length;
  if (n === 0) return 0;
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < n; i += 1) {
    if (x <= points[i][0]) {
      const [x0, y0] = points[i - 1];
      const [x1, y1] = points[i];
      if (x1 === x0) return y1;
      return lerp(y0, y1, (x - x0) / (x1 - x0));
    }
  }
  return points[n - 1][1];
}

/** 加权平均，自动跳过 null/undefined 并重新归一化权重。 */
export function weightedMean(pairs) {
  let sum = 0;
  let wsum = 0;
  for (const [value, weight] of pairs) {
    if (value == null || Number.isNaN(value)) continue;
    sum += value * weight;
    wsum += weight;
  }
  return wsum === 0 ? null : sum / wsum;
}

export function stdev(values) {
  const arr = values.filter((v) => v != null && !Number.isNaN(v));
  if (arr.length < 2) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  return Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length);
}
