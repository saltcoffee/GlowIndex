/**
 * 六个评分因子。每个函数都是纯函数：输入观测值，输出 0–1 的分和一句中文解释。
 *
 * 设计原则：
 *  1. 全部用分段线性函数，曲线的每个拐点都能在文档里对照，方便按本地经验调参；
 *  2. 每个因子都必须说明"为什么是这个分"，最终原样透出给用户；
 *  3. 缺数据时给中性分，而不是 0 分——避免上游少一个字段就把结论打成"不烧"。
 *
 * 另外有一个关键结构：最终分数不是六项加权求和的直接结果，
 * 还要乘上"可烧云量闸门"。这解决了一个纯加权模型无法表达的事实：
 * 天上一朵云都没有时，光路再通畅也没有东西可以烧。
 */

import { WEIGHTS } from '../config.js';
import { ramp, round, weightedMean } from '../lib/mathx.js';

export const FACTOR_META = {
  sunAngle: { name: '太阳高度角', weight: WEIGHTS.sunAngle },
  canvas: { name: '中高云画布', weight: WEIGHTS.canvas },
  lowCloud: { name: '低云遮挡', weight: WEIGHTS.lowCloud },
  clarity: { name: '空气通透度', weight: WEIGHTS.clarity },
  precip: { name: '降水抑制', weight: WEIGHTS.precip },
  wind: { name: '风力质感', weight: WEIGHTS.wind },
};

/**
 * 因子 1：太阳高度角。
 * 地平线附近 → 光线穿过最厚的大气，蓝光被散射掉，只剩红橙；
 * 太阳太高 → 天空还亮，霞光对比不足；太阳太深 → 高层云已经照不到。
 */
export function scoreSunAngle(elevation) {
  if (elevation == null) return { score: 0.5, detail: '缺少太阳位置数据' };
  const score = ramp(elevation, [
    [-8, 0],
    [-5, 0.2],
    [-3, 0.6],
    [-1.5, 1],
    [1, 1],
    [3, 0.85],
    [6, 0.45],
    [9, 0.1],
    [10, 0],
  ]);
  // 解释文案跟着"得分"走，并且区分"在地平线上/下"，
  // 否则会出现"高度角 +4.8°"却写着"沉得比较深"这种自相矛盾
  const deg = elevation.toFixed(1);
  let detail;
  if (score >= 0.9) detail = `太阳高度角 ${deg}°，正贴着地平线，红光最强`;
  else if (score >= 0.7) detail = `太阳高度角 ${deg}°，已离开最佳角度，红光还在但弱一些`;
  else if (score >= 0.4) detail = `太阳高度角 ${deg}°，偏离地平线较多，能照到的高层云在减少`;
  else if (elevation < 0) detail = `太阳高度角 ${deg}°，已经沉得太深，高层云照不到了`;
  else detail = `太阳高度角 ${deg}°，太阳还太高，天色偏白`;
  return { score, detail };
}

/**
 * 因子 2：中高云"画布"。
 *
 * 关键点一：高云和中云的"最佳云量"不一样。
 *   - 高云（卷云/卷层云）越满越好：整片天都被染色，是典型的世纪大烧；
 *   - 中云（高积云/高层云）最佳在 40–60%：太少没东西烧，铺满就变成灰锅盖。
 *
 * 关键点二：中云会遮挡高云。中云铺满时，太阳的光根本照不到上面的高云，
 * 所以"高云 51%"不等于"有 51% 的高云可以烧"。这里用遮挡系数折减后再评分。
 */
const HIGH_CURVE = [
  [0, 0],
  [10, 0.15],
  [25, 0.55],
  [40, 0.85],
  [55, 0.98],
  [70, 1],
  [85, 0.95],
  [100, 0.85],
];
const MID_CURVE = [
  [0, 0],
  [10, 0.2],
  [25, 0.6],
  [40, 0.9],
  [55, 1],
  [70, 0.85],
  [85, 0.5],
  [100, 0.25],
];

/** 中云对高云的遮挡系数：中云 0 → 1.0，中云 100% → 0.3。 */
function highVisibility(mid) {
  const m = Math.max(0, Math.min(100, mid ?? 0));
  return 1 - 0.7 * (m / 100);
}

/**
 * 实际能被点亮的云量（0–100），闸门和画布因子共用同一个口径。
 * 取"未被遮挡的高云"与"中云本身"的较大者。
 */
export function litCoverage(mid, high) {
  const effectiveHigh = (high ?? 0) * highVisibility(mid);
  return Math.max(effectiveHigh, (mid ?? 0) * 0.9);
}

export function scoreCanvas(mid, high, inferred = false) {
  const effectiveHigh = high == null ? null : high * highVisibility(mid);
  const hiScore = effectiveHigh == null ? null : ramp(effectiveHigh, HIGH_CURVE);
  const midScore = mid == null ? null : ramp(mid, MID_CURVE);

  let score = null;
  if (hiScore != null && midScore != null) score = Math.max(hiScore, midScore * 0.9);
  else if (hiScore != null) score = hiScore;
  else if (midScore != null) score = midScore * 0.9;

  if (score == null) return { score: 0.5, detail: '缺少云量数据' };

  const litCover = litCoverage(mid, high);
  const parts = [];
  if (mid != null) parts.push(`中云 ${Math.round(mid)}%`);
  if (high != null) parts.push(`高云 ${Math.round(high)}%`);
  const occluded = mid != null && high != null && mid >= 30 && high >= 10;
  const head = `${parts.length ? parts.join(' / ') : '云量'}${inferred ? '（由总云量推断）' : ''}`;

  let detail;
  if (litCover < 10) detail = `${head}，天上几乎没有能被打亮的云`;
  else if (litCover < 25) detail = `${head}，云量偏少，只能指望局部出彩`;
  else if (occluded && effectiveHigh < high * 0.7) {
    detail = `${head}，中云挡住了大部分高云，实际能烧的范围比看到的少`;
  } else if (litCover <= 80) detail = `${head}，正处在最容易出彩的云量区间`;
  else if ((high ?? 0) >= 85) detail = `${head}，整层卷云，天空有整体染红的潜力`;
  else detail = `${head}，中云铺得太满，容易闷成灰锅盖`;

  return { score, detail, litCover: round(litCover, 0) };
}

/**
 * 因子 3：低云遮挡。
 * 这是"一票否决"型因子：太阳方向的低云会直接截断光路。
 */
export function scoreLowCloud(low) {
  if (low == null) return { score: 0.5, detail: '缺少低云数据' };
  const score = ramp(low, [
    [0, 1],
    [8, 0.95],
    [15, 0.8],
    [25, 0.55],
    [40, 0.25],
    [55, 0.08],
    [70, 0],
  ]);
  let detail;
  if (low <= 15) detail = `低云 ${Math.round(low)}%，地平线干净，光路通畅`;
  else if (low <= 30) detail = `低云 ${Math.round(low)}%，少量低云可能挡掉最精彩的一段`;
  else if (low <= 50) detail = `低云 ${Math.round(low)}%，太阳方向被挡住的可能性很大`;
  else detail = `低云 ${Math.round(low)}%，天边被厚云封住，基本看不到火烧云`;
  return { score, detail };
}

/**
 * 因子 4：空气通透度。
 * 能见度（悬浮物）、露点差（干湿）、相对湿度（雾/水汽）、气溶胶光学厚度（霾/沙尘）
 * 四个子项加权。缺 AOD 时自动重新归一化权重，不会因为少一个源就误伤。
 */
export function scoreClarity({ visKm, tempC, dewC, rh, aod }) {
  const spread = tempC != null && dewC != null ? tempC - dewC : null;

  const visScore = visKm == null
    ? null
    : ramp(visKm, [
        [0.5, 0.05],
        [2, 0.2],
        [4, 0.4],
        [6, 0.6],
        [10, 0.85],
        [16, 1],
        [30, 1],
      ]);
  const spreadScore = spread == null
    ? null
    : ramp(spread, [
        [0, 0.15],
        [1, 0.35],
        [2, 0.6],
        [4, 0.85],
        [8, 1],
        [20, 1],
      ]);
  const rhScore = rh == null
    ? null
    : ramp(rh, [
        [30, 0.8],
        [45, 1],
        [65, 0.95],
        [78, 0.8],
        [88, 0.55],
        [95, 0.3],
        [100, 0.2],
      ]);
  const aodScore = aod == null
    ? null
    : ramp(aod, [
        [0.05, 1],
        [0.2, 0.95],
        [0.5, 0.75],
        [0.8, 0.5],
        [1.2, 0.3],
        [2, 0.15],
      ]);

  const score = weightedMean([
    [visScore, 0.42],
    [spreadScore, 0.25],
    [rhScore, 0.15],
    [aodScore, 0.18],
  ]);
  if (score == null) return { score: 0.5, detail: '缺少空气质量与能见度数据' };

  const parts = [];
  if (visKm != null) parts.push(`能见度 ${round(visKm, 0)}km`);
  if (rh != null) parts.push(`湿度 ${Math.round(rh)}%`);
  if (spread != null) parts.push(`露点差 ${round(spread, 1)}℃`);
  if (aod != null) parts.push(`气溶胶 ${round(aod, 2)}`);
  const head = parts.join('，') || '空气通透度';

  let detail;
  if (visKm != null && visKm < 6) detail = `${head}，悬浮物偏多，颜色会发灰`;
  else if (rh != null && rh >= 90) detail = `${head}，水汽太重，容易糊成一片`;
  else if (aod != null && aod >= 0.8) detail = `${head}，霾或沙尘会压暗整个天幕`;
  else if (spread != null && spread < 2) detail = `${head}，接近饱和，晨昏容易起雾`;
  else if (score >= 0.93) detail = `${head}，空气通透，色彩饱和度有保障`;
  else if (score >= 0.8) detail = `${head}，通透度中上，颜色能出来但不算最干净`;
  else detail = `${head}，通透度一般，颜色会略微发灰`;
  return { score, detail };
}

/**
 * 因子 5：降水抑制。
 * 正在下雨 = 没戏；但"刚停雨"反而是加分项（见修正项）。
 */
export function scorePrecip({ precipNow, precipWindowMax, chanceRain }) {
  const worst = Math.max(precipNow ?? 0, precipWindowMax ?? 0);
  const pScore = ramp(worst, [
    [0, 1],
    [0.1, 0.95],
    [0.5, 0.8],
    [1.2, 0.55],
    [3, 0.3],
    [6, 0.12],
    [10, 0],
  ]);
  const cScore = chanceRain == null
    ? null
    : ramp(chanceRain, [
        [0, 1],
        [30, 0.92],
        [60, 0.72],
        [80, 0.5],
        [100, 0.32],
      ]);
  const score = weightedMean([
    [pScore, 0.65],
    [cScore, 0.35],
  ]);

  let detail;
  if ((precipNow ?? 0) >= 0.2) detail = `此刻正在下雨（${round(precipNow, 1)}mm）`;
  else if (worst >= 0.5) detail = `窗口内可能有降水（最大 ${round(worst, 1)}mm）`;
  else if ((chanceRain ?? 0) >= 60) detail = `降水概率 ${Math.round(chanceRain)}%，云系不稳定`;
  else detail = '窗口内无明显降水';
  return { score, detail };
}

/**
 * 因子 6：风力质感。
 * 静风 → 霾和水汽堆积；微风 → 云被拉出纹理；大风 → 云被吹散或压成厚层。
 * 权重最低，只作为微调。
 */
export function scoreWind({ windKph, gustKph }) {
  if (windKph == null && gustKph == null) return { score: 0.5, detail: '缺少风力数据' };
  const eff = Math.max(windKph ?? 0, (gustKph ?? 0) * 0.55);
  const score = ramp(eff, [
    [0, 0.55],
    [4, 0.8],
    [8, 1],
    [20, 0.95],
    [30, 0.7],
    [45, 0.4],
    [70, 0.15],
  ]);
  let detail;
  if (eff < 4) detail = `风力 ${round(windKph ?? eff, 0)}km/h，几乎静风，霾不容易散`;
  else if (eff <= 25) detail = `风力 ${round(windKph ?? eff, 0)}km/h，微风能把云拉出纹理`;
  else if (eff <= 45) detail = `风力 ${round(windKph ?? eff, 0)}km/h，风有点大，云容易被吹散`;
  else detail = `风力 ${round(windKph ?? eff, 0)}km/h，大风天，云层状态很难稳定`;
  return { score, detail };
}

/** "可烧云量"闸门：没有云可烧时，再怎么通透也没用。 */
export function canvasGate(litCover) {
  const gate = ramp(litCover ?? 0, [
    [0, 0],
    [10, 0.25],
    [22, 0.55],
    [38, 0.9],
    [48, 1],
    [100, 1],
  ]);
  return 0.15 + 0.85 * gate;
}

/**
 * 对一个采样点做完整评分。
 * @param {object} ctx
 * @param {number} ctx.elevation 太阳高度角（度）
 * @param {object} ctx.weather 该时刻的天气（见 series.js 的 sampleSeries）
 * @param {number} ctx.rainBefore 过去 12h 累计降水（mm）
 * @param {number} ctx.precipWindowMax 事件窗口内的最大小时降水（mm）
 * @returns {{factors: object[], modifiers: object[], base: number, score: number, gate: number}}
 */
export function evaluateSample({ elevation, weather, rainBefore = 0, precipWindowMax = 0 }) {
  const w = weather || {};
  const raw = {
    sunAngle: scoreSunAngle(elevation),
    canvas: scoreCanvas(w.cloudMid, w.cloudHigh, w.layered === false),
    lowCloud: scoreLowCloud(w.cloudLow),
    clarity: scoreClarity({
      visKm: w.visKm,
      tempC: w.tempC,
      dewC: w.dewC,
      rh: w.rh,
      aod: w.aod,
    }),
    precip: scorePrecip({
      precipNow: w.precipMm,
      precipWindowMax,
      chanceRain: w.chanceRain,
    }),
    wind: scoreWind({ windKph: w.windKph, gustKph: w.gustKph }),
  };

  const factors = Object.entries(raw).map(([key, r]) => ({
    key,
    name: FACTOR_META[key].name,
    score: round(r.score ?? 0, 3),
    weight: FACTOR_META[key].weight,
    contribution: round((r.score ?? 0) * FACTOR_META[key].weight * 100, 1),
    detail: r.detail,
  }));

  const base = factors.reduce((sum, f) => sum + f.contribution, 0);
  let score = base;
  const modifiers = [];

  // 加分：雨后空气被洗过，是经典的大烧前兆。
  // 下限 0.5mm 是刻意的——0.2mm 那种"地面刚湿"洗不动空气，不该加分。
  if (rainBefore >= 0.5 && rainBefore <= 15 && (w.precipMm ?? 0) < 0.1 && (w.visKm ?? 0) >= 12) {
    score += 3;
    modifiers.push({
      key: 'postRainClean',
      name: '雨后通透',
      effect: '+3',
      detail: `过去 12 小时累计降水 ${round(rainBefore, 1)}mm，空气被洗过，色彩更透`,
    });
  }

  // 惩罚：低云铺满，光根本进不来
  if ((w.cloudLow ?? 0) >= 85) {
    score *= 0.55;
    modifiers.push({
      key: 'overcastDeck',
      name: '低云封天',
      effect: '×0.55',
      detail: `低云 ${Math.round(w.cloudLow)}%，整层挡住光路`,
    });
  }

  // 惩罚：雾
  if ((w.visKm ?? 99) < 1.5 && (w.rh ?? 0) >= 95) {
    score *= 0.6;
    modifiers.push({
      key: 'fogRisk',
      name: '雾/水汽',
      effect: '×0.6',
      detail: `能见度仅 ${round(w.visKm, 1)}km 且湿度接近饱和`,
    });
  }

  // 惩罚：正在下雨
  if ((w.precipMm ?? 0) >= 2) {
    score *= 0.7;
    modifiers.push({
      key: 'rainingNow',
      name: '正在降水',
      effect: '×0.7',
      detail: `小时降水 ${round(w.precipMm, 1)}mm`,
    });
  }

  // 闸门：可烧云量不足时，整体成色线性打折
  const litCover = litCoverage(w.cloudMid, w.cloudHigh);
  const gate = canvasGate(litCover);
  if (gate < 0.98) {
    score *= gate;
    modifiers.push({
      key: 'canvasGate',
      name: '可烧云量',
      effect: `×${gate.toFixed(2)}`,
      detail: `能被打亮的云约 ${Math.round(litCover)}%，云不够多，整体成色受限`,
    });
  }

  return {
    factors,
    modifiers,
    base: round(base, 1),
    gate: round(gate, 3),
    score: Math.max(0, Math.min(100, score)),
  };
}
