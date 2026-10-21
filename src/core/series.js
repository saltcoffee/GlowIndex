/** 把多源数据合并成一条按 UTC 时间升序的逐小时序列。 */

import { ramp } from '../lib/mathx.js';

// 主序列保留基础天气，MET 温湿独立保存；这样跨覆盖边界时能完全回退到同一基础源。
// 使用普通对象保存，经过缓存的 JSON 序列化后仍保留来源边界。
const LAYER_WEATHER_FIELDS = ['rh', 'tempC', 'dewC'];

function sampledWeather(row) {
  const { layerWeather, ...out } = row;
  if (out.layered && layerWeather) {
    for (const key of LAYER_WEATHER_FIELDS) {
      if (layerWeather[key] != null) out[key] = layerWeather[key];
    }
  }
  return out;
}

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

/** 仅在序列真实覆盖范围内线性插值；范围外不外推。 */
export function sampleSeries(series, tMs) {
  if (!series?.length || !Number.isFinite(tMs)) return null;
  const first = series[0];
  const last = series[series.length - 1];
  if (tMs < first.t || tMs > last.t) return null;

  if (tMs === first.t) return sampledWeather(first);
  if (tMs === last.t) return sampledWeather(last);

  let lo = 0;
  let hi = series.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (series[mid].t <= tMs) lo = mid;
    else hi = mid;
  }
  const a = series[lo];
  const b = series[hi];
  if (tMs === a.t) return sampledWeather(a);
  if (tMs === b.t) return sampledWeather(b);
  const f = (tMs - a.t) / (b.t - a.t);

  const out = { t: tMs, layered: a.layered === true && b.layered === true };
  for (const key of NUMERIC_FIELDS) {
    const av = a[key];
    const bv = b[key];
    // 单侧缺失意味着该字段没有覆盖整个区间，不能借用另一端补齐。
    out[key] = av == null || bv == null ? null : av + (bv - av) * f;
  }
  if (out.layered && a.layerWeather && b.layerWeather) {
    for (const key of LAYER_WEATHER_FIELDS) {
      const av = a.layerWeather[key];
      const bv = b.layerWeather[key];
      if (av != null && bv != null) out[key] = av + (bv - av) * f;
    }
  } else if (Boolean(a.layered) !== Boolean(b.layered)) {
    // 真分层与推断小时之间没有完整的分层覆盖，不能按最近端点宣称有真分层。
    const inferred = inferLayers(out);
    out.cloudLow = inferred.low;
    out.cloudMid = inferred.mid;
    out.cloudHigh = inferred.high;
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

/** 在已覆盖的基础天气上合并同一时刻的补充数据。 */
function mergeSources(weather, omAt, aqAt) {
  if (!weather) return null;
  const base = { ...weather };
  if (omAt && omAt.cloudLow != null && omAt.cloudMid != null && omAt.cloudHigh != null) {
    base.cloudLow = omAt.cloudLow;
    base.cloudMid = omAt.cloudMid;
    base.cloudHigh = omAt.cloudHigh;
    base.layered = true;
    base.layerWeather = {};
    for (const key of LAYER_WEATHER_FIELDS) {
      base.layerWeather[key] = omAt[key] ?? null;
    }
  } else {
    const inferred = inferLayers(base);
    base.cloudLow = inferred.low;
    base.cloudMid = inferred.mid;
    base.cloudHigh = inferred.high;
    base.layered = false;
  }
  base.aod = aqAt?.aod ?? null;
  return base;
}

/**
 * 生成主序列。
 * @param {object[]} hours WeatherAPI 的逐小时数组（作为时间骨架，保证覆盖预报时段）
 * @param {object[]|null} om MET Norway 的分层云序列
 * @param {object[]|null} aq AOD 序列
 */
export function buildSeries({ hours, om, aq }) {
  const weather = hours.map((h) => ({
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
  })).sort((a, b) => a.t - b.t);
  return weather.map((row) => mergeSources(
    row,
    sampleSeries(om, row.t),
    sampleSeries(aq, row.t),
  ));
}

/** 给"全天云量波动"用的稳健离散度。 */
export function cloudSpread(series, fromMs, toMs) {
  if (!series?.length || toMs <= fromMs) return 0;
  const start = Math.max(fromMs, series[0].t);
  const end = Math.min(toMs, series[series.length - 1].t);
  if (end <= start) return 0;
  const vals = [];
  const startAt = sampleSeries(series, start);
  if (startAt?.cloudTotal != null) vals.push(startAt.cloudTotal);
  for (const row of series) {
    if (row.t <= start) continue;
    if (row.t >= end) break;
    if (row.cloudTotal != null) vals.push(row.cloudTotal);
  }
  const endAt = sampleSeries(series, end);
  if (endAt?.cloudTotal != null) vals.push(endAt.cloudTotal);
  if (vals.length < 2) return 0;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  return Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
}

export { ramp };
