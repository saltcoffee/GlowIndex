/** 把多源数据合并成一条按 UTC 时间升序的逐小时序列。 */

import { ramp } from '../lib/mathx.js';

/** 参与插值的数值字段。 */
export const NUMERIC_FIELDS = [
  'cloudTotal',
  'cloudLow',
  'cloudMid',
  'cloudHigh',
  'rh',
  'tempC',
  'dewC',
  'visKm',
  'windKph',
  'gustKph',
  'precipMm',
  'chanceRain',
  'uv',
  'aod',
];

/**
 * 缺分层云量时，用总云量 + 湿度 + 能见度 + 降水反推低/中/高云。
 * 这是降级方案，经验规则，准确度明显低于真分层数据：
 *   湿气重 / 能见度差 / 正在下雨 → 大概率是低云（层云、雨层云）
 *   干爽通透 → 大概率是中高云（卷云、高积云）
 */
export function inferLayers({ cloudTotal = 0, rh = null, visKm = null, precipMm = 0 }) {
  const t = Math.max(0, Math.min(100, cloudTotal ?? 0));
  if ((rh != null && rh >= 88) || (visKm != null && visKm < 6) || (precipMm ?? 0) > 0.3) {
    return { low: t * 0.8, mid: t * 0.15, high: t * 0.05 };
  }
  if ((rh == null || rh <= 60) && (visKm == null || visKm >= 15)) {
    return { low: t * 0.15, mid: t * 0.45, high: t * 0.4 };
  }
  return { low: t * 0.45, mid: t * 0.35, high: t * 0.2 };
}

/** 在序列里线性插值取任意时刻的值（超出两端取端点）。 */
export function sampleSeries(series, tMs) {
  if (!series || series.length === 0) return null;
  if (tMs <= series[0].t) return { ...series[0], t: tMs };
  const last = series[series.length - 1];
  if (tMs >= last.t) return { ...last, t: tMs };

  let lo = 0;
  let hi = series.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (series[mid].t <= tMs) lo = mid;
    else hi = mid;
  }
  const a = series[lo];
  const b = series[hi];
  const span = b.t - a.t;
  const f = span === 0 ? 0 : (tMs - a.t) / span;

  const out = { t: tMs, layered: f < 0.5 ? a.layered : b.layered };
  for (const key of NUMERIC_FIELDS) {
    const av = a[key];
    const bv = b[key];
    if (av == null && bv == null) out[key] = null;
    else if (av == null) out[key] = bv;
    else if (bv == null) out[key] = av;
    else out[key] = av + (bv - av) * f;
  }
  out.conditionText = f < 0.5 ? a.conditionText : b.conditionText;
  return out;
}

/** 区间内累计降水（逐小时 mm 求和）。 */
export function sumPrecip(series, fromMs, toMs) {
  let sum = 0;
  for (const row of series) {
    if (row.t < fromMs) continue;
    if (row.t > toMs) break;
    if (row.precipMm != null) sum += row.precipMm;
  }
  return sum;
}

/** 区间内最大小时降水。 */
export function maxPrecip(series, fromMs, toMs) {
  let max = 0;
  for (const row of series) {
    if (row.t < fromMs) continue;
    if (row.t > toMs) break;
    if (row.precipMm != null && row.precipMm > max) max = row.precipMm;
  }
  return max;
}

/**
 * 生成主序列。
 * @param {object[]} hours WeatherAPI 的逐小时数组（作为时间骨架，保证覆盖预报时段）
 * @param {object|null} om MET Norway 的分层云序列（只含 t / cloudLow / cloudMid / cloudHigh）
 * @param {object|null} aq AOD 序列
 */
export function buildSeries({ hours, om, aq }) {
  const rows = [];
  for (const h of hours) {
    const base = {
      t: h.t,
      cloudTotal: h.cloudTotal ?? null,
      rh: h.rh ?? null,
      tempC: h.tempC ?? null,
      dewC: h.dewC ?? null,
      visKm: h.visKm ?? null,
      windKph: h.windKph ?? null,
      gustKph: h.gustKph ?? null,
      precipMm: h.precipMm ?? null,
      chanceRain: h.chanceRain ?? null,
      uv: h.uv ?? null,
      conditionText: h.condition ?? null,
      layered: false,
      aod: null,
      cloudLow: null,
      cloudMid: null,
      cloudHigh: null,
    };

    const omAt = om ? sampleSeries(om, h.t) : null;
    if (omAt && omAt.cloudLow != null && omAt.cloudMid != null && omAt.cloudHigh != null) {
      base.cloudLow = omAt.cloudLow;
      base.cloudMid = omAt.cloudMid;
      base.cloudHigh = omAt.cloudHigh;
      base.layered = true;
      // 分层源更细的字段优先用于通透度判断
      if (omAt.rh != null) base.rh = omAt.rh;
      if (omAt.tempC != null) base.tempC = omAt.tempC;
      if (omAt.dewC != null) base.dewC = omAt.dewC;
      if (omAt.visKm != null) base.visKm = omAt.visKm;
      if (omAt.windKph != null) base.windKph = omAt.windKph;
      if (omAt.gustKph != null) base.gustKph = omAt.gustKph;
      if (omAt.precipMm != null) base.precipMm = omAt.precipMm;
    } else {
      const inferred = inferLayers({
        cloudTotal: base.cloudTotal ?? 0,
        rh: base.rh,
        visKm: base.visKm,
        precipMm: base.precipMm,
      });
      base.cloudLow = inferred.low;
      base.cloudMid = inferred.mid;
      base.cloudHigh = inferred.high;
      base.layered = false;
    }

    if (aq) {
      const aqAt = sampleSeries(aq, h.t);
      if (aqAt && aqAt.aod != null) base.aod = aqAt.aod;
    }

    rows.push(base);
  }

  rows.sort((a, b) => a.t - b.t);
  return rows;
}

/** 给"全天云量波动"用的稳健离散度。 */
export function cloudSpread(series, fromMs, toMs) {
  const vals = [];
  for (const row of series) {
    if (row.t < fromMs) continue;
    if (row.t > toMs) break;
    if (row.cloudTotal != null) vals.push(row.cloudTotal);
  }
  if (vals.length < 2) return 0;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  return Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
}

export { ramp };
