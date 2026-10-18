/** 开发工具的小工具函数。 */

/** 夹取到 [min, max]。 */
export function clamp0(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

/** 保留小数。 */
export function round(v, digits = 1) {
  const p = 10 ** digits;
  return Math.round(v * p) / p;
}

/** "YYYY-MM-DD" 加天数。 */
export function addDays(dateStr, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr));
  if (!m) throw new Error(`无效日期: ${dateStr}`);
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + n * 86400000;
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
    d.getUTCDate(),
  ).padStart(2, '0')}`;
}
