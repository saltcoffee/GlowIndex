/**
 * 编排层：把一天的预报 + 太阳位置 → 一次朝霞/晚霞的完整评估。
 *
 * 核心流程：
 *   1. 拿到事件时刻（优先用 WeatherAPI 的 astro，天文算法做交叉校验）
 *   2. 在事件前后开一个评分窗口，每 5 分钟采一个点
 *   3. 每个点算太阳高度角 + 天气因子 → 分数
 *   4. 取窗口内最高分作为这次事件的"强度"，并记录峰值时刻
 */

import { COMPASS_16, LIMITS } from '../config.js';
import { clamp, round } from '../lib/mathx.js';
import { sunElevationAzimuth, sunTimes } from '../lib/solar.js';
import { formatClock, parseAstroClock, parseDateStr, wallToUtc } from '../lib/time.js';
import { buildAdvice } from './advice.js';
import { evaluateSample } from './factors.js';
import { levelFor, levelPayload } from './levels.js';
import { cloudSpread, maxPrecip, sampleSeries, sumPrecip } from './series.js';

const MS_MIN = 60000;
const MS_HOUR = 3600000;

/** 方位角 → 中文 16 方位。 */
export function compassName(az) {
  if (!Number.isFinite(az)) return null;
  const idx = Math.round((((az % 360) + 360) % 360) / 22.5) % 16;
  return COMPASS_16[idx];
}

const labelFor = (type) => (type === 'sunset' ? '晚霞' : '朝霞');
const rn = (v, d = 0) => (v == null || Number.isNaN(v) ? null : round(v, d));

/**
 * 置信度：不参与打分，只告诉用户"这个结论有多可信"。
 * 缺分层云 / 缺 AOD / 预报时效远 / 云量剧烈波动，都会降分。
 */
function estimateConfidence({ sampleLayered, layered, dayIndex, astroDriftMin, spread }) {
  let c = 0.94;
  if (!sampleLayered) c -= 0.16; // 云层是推断出来的，最关键变量不可靠
  if (!layered) c -= 0.05;
  c -= Math.min(0.18, 0.06 * dayIndex); // 第 3 天明显不如第 1 天
  if (astroDriftMin != null && Math.abs(astroDriftMin) > 3) c -= 0.03;
  if (spread > 25) c -= 0.08;
  else if (spread > 15) c -= 0.04;
  return clamp(round(c, 2), 0.35, 0.98);
}

function buildNotes({ layered, sampleLayered, dayIndex, astroDriftMin }) {
  const notes = [];
  if (!layered) notes.push('未拿到分层云量，低/中/高云由总云量与湿度推断，误差较大');
  else if (!sampleLayered) notes.push('该时段缺少分层云量，已用相邻时段插值');
  if (dayIndex >= 1) notes.push(`这是第 ${dayIndex + 1} 天的预报，时效越长不确定性越大`);
  if (astroDriftMin != null && Math.abs(astroDriftMin) > 3) {
    notes.push(`上游日出日落时刻与天文计算相差约 ${astroDriftMin} 分钟，已以上游为准`);
  }
  return notes;
}

/**
 * 评估单次事件。
 * @returns {object|null}
 */
function buildEvent({
  type,
  date,
  astro,
  lat,
  lon,
  tz,
  series,
  layered,
  dayIndex,
  withTimeline,
}) {
  const p = parseDateStr(date);
  if (!p) return null;

  const computed = sunTimes(lat, lon, date, { tz });
  const computedMs = type === 'sunset' ? computed.sunsetMs : computed.sunriseMs;

  // 事件时刻：优先用 WeatherAPI 的 astro（与它的逐小时数据同一套天文参数）
  const parsed = parseAstroClock(astro?.[type]);
  let centerMs = computedMs;
  let astroDriftMin = null;
  if (parsed) {
    const fromAstro = wallToUtc(tz, p.y, p.m, p.d, parsed.hh, parsed.mm);
    if (computedMs != null) astroDriftMin = Math.round((fromAstro - computedMs) / MS_MIN);
    centerMs = fromAstro;
  }

  if (centerMs == null) {
    return {
      id: `${date}-${type}`,
      type,
      label: labelFor(type),
      date,
      eventTime: null,
      peakTime: null,
      window: null,
      score: 0,
      level: levelPayload(levelFor(0)),
      sun: { direction: null, elevationAtPeak: null, azimuthAtPeak: null },
      factors: [],
      modifiers: [],
      weather: null,
      timeline: [],
      advice: [
        computed.kind === 'polar-day'
          ? '该地当天为极昼，太阳不落，没有常规的日出日落'
          : '该地当天为极夜，太阳不升',
      ],
      confidence: 0.4,
      confidenceBasis: [],
      notes: [computed.kind === 'polar-day' ? '极昼' : '极夜'],
      __ms: Number.MAX_SAFE_INTEGER,
    };
  }

  const span = LIMITS.window[type];
  const startMs = centerMs - span.before * MS_MIN;
  const endMs = centerMs + span.after * MS_MIN;
  const stepMs = LIMITS.sampleStepMin * MS_MIN;
  const precipWindowMax = maxPrecip(series, startMs, endMs);

  let best = null;
  const timelineBySlot = new Map();
  // 色彩最浓的时刻通常落后于日落（约 +8 分钟）、早于日出（约 -8 分钟）。
  // 分数接近时用这个"偏好时刻"打破平手，让 peakTime 更符合实际观感。
  const preferMs = centerMs + (type === 'sunset' ? 8 : -8) * MS_MIN;

  for (let t = startMs; t <= endMs + 1; t += stepMs) {
    const sun = sunElevationAzimuth(lat, lon, t);
    if (sun.elevation < LIMITS.elevation.min || sun.elevation > LIMITS.elevation.max) continue;

    const weather = sampleSeries(series, t);
    if (!weather) break;

    const rainBefore = sumPrecip(series, t - 12 * MS_HOUR, t - MS_HOUR);
    const evaluated = evaluateSample({
      elevation: sun.elevation,
      weather,
      rainBefore,
      precipWindowMax,
    });
    const sample = { t, elevation: sun.elevation, azimuth: sun.azimuth, weather, ...evaluated };

    if (!best) best = sample;
    else if (sample.score > best.score + 0.5) best = sample;
    else if (
      Math.abs(sample.score - best.score) <= 0.5 &&
      Math.abs(sample.t - preferMs) < Math.abs(best.t - preferMs)
    ) {
      best = sample;
    }

    if (withTimeline) {
      const slot = Math.round((t - startMs) / (LIMITS.timelineStepMin * MS_MIN));
      if (!timelineBySlot.has(slot)) timelineBySlot.set(slot, sample);
    }
  }

  // 兜底：窗口内一个可用点都没有（例如序列没覆盖到那天）
  if (!best) {
    const weather = sampleSeries(series, centerMs);
    if (!weather) return null;
    const sun = sunElevationAzimuth(lat, lon, centerMs);
    best = {
      t: centerMs,
      elevation: sun.elevation,
      azimuth: sun.azimuth,
      weather,
      ...evaluateSample({
        elevation: sun.elevation,
        weather,
        rainBefore: sumPrecip(series, centerMs - 12 * MS_HOUR, centerMs - MS_HOUR),
        precipWindowMax,
      }),
    };
  }

  const level = levelFor(best.score);
  const spread = cloudSpread(series, startMs, endMs);
  const confidence = estimateConfidence({
    sampleLayered: Boolean(best.weather.layered),
    layered,
    dayIndex,
    astroDriftMin,
    spread,
  });
  const notes = buildNotes({
    layered,
    sampleLayered: Boolean(best.weather.layered),
    dayIndex,
    astroDriftMin,
  });

  const w = best.weather;
  const direction = compassName(best.azimuth);
  const atEvent = sunElevationAzimuth(lat, lon, centerMs);

  const timeline = withTimeline
    ? [...timelineBySlot.entries()]
        .sort((a, b) => a[0] - b[0])
        .slice(0, LIMITS.maxTimelinePoints)
        .map(([, s]) => ({
          time: formatClock(tz, s.t),
          elevation: round(s.elevation, 1),
          score: round(s.score, 1),
          level: levelFor(s.score).name,
          cloudLow: rn(s.weather.cloudLow, 0),
          cloudMid: rn(s.weather.cloudMid, 0),
          cloudHigh: rn(s.weather.cloudHigh, 0),
          precipMm: rn(s.weather.precipMm, 2),
        }))
    : [];

  return {
    id: `${date}-${type}`,
    type,
    label: labelFor(type),
    date,
    eventTime: formatClock(tz, centerMs),
    peakTime: formatClock(tz, best.t),
    peakOffsetMin: Math.round((best.t - centerMs) / MS_MIN),
    window: {
      start: formatClock(tz, startMs),
      end: formatClock(tz, endMs),
      durationMin: Math.round((endMs - startMs) / MS_MIN),
    },
    score: round(best.score, 1),
    level: levelPayload(level),
    sun: {
      elevationAtPeak: round(best.elevation, 2),
      azimuthAtPeak: round(best.azimuth, 1),
      elevationAtEvent: round(atEvent.elevation, 2),
      azimuthAtEvent: round(atEvent.azimuth, 1),
      direction,
      whereToLook:
        direction == null
          ? null
          : type === 'sunset'
            ? `朝 ${direction} 方向（方位角 ${Math.round(best.azimuth)}°）看`
            : `朝 ${direction} 方向（方位角 ${Math.round(best.azimuth)}°）看`,
    },
    factors: best.factors,
    modifiers: best.modifiers,
    weather: {
      cloudTotal: rn(w.cloudTotal, 0),
      cloudLow: rn(w.cloudLow, 0),
      cloudMid: rn(w.cloudMid, 0),
      cloudHigh: rn(w.cloudHigh, 0),
      layered: Boolean(w.layered),
      humidity: rn(w.rh, 0),
      tempC: rn(w.tempC, 1),
      dewpointC: rn(w.dewC, 1),
      visKm: rn(w.visKm, 1),
      windKph: rn(w.windKph, 0),
      gustKph: rn(w.gustKph, 0),
      precipMm: rn(w.precipMm, 2),
      chanceOfRain: rn(w.chanceRain, 0),
      aod: rn(w.aod, 2),
      condition: w.conditionText ?? null,
    },
    timeline,
    advice: buildAdvice({ level, factors: best.factors, modifiers: best.modifiers, type, confidence }),
    confidence,
    notes,
    __ms: centerMs,
  };
}

/**
 * 评估若干天的日出与日落。
 * @param {object} params
 * @param {Array<{date: string, astro: object}>} params.days
 * @param {'all'|'sunrise'|'sunset'} [params.eventFilter]
 * @returns {object[]} 按事件时刻升序
 */
export function analyzeEvents({
  lat,
  lon,
  tz,
  series,
  days,
  eventFilter = 'all',
  withTimeline = true,
  layered = false,
}) {
  const events = [];

  days.forEach((day, dayIndex) => {
    const types = eventFilter === 'all' ? ['sunrise', 'sunset'] : [eventFilter];
    for (const type of types) {
      const ev = buildEvent({
        type,
        date: day.date,
        astro: day.astro,
        lat,
        lon,
        tz,
        series,
        layered,
        dayIndex,
        withTimeline,
      });
      if (ev) events.push(ev);
    }
  });

  events.sort((a, b) => a.__ms - b.__ms);
  return events;
}

/** 选"最值得看的那一场"：优先还没结束的，其次分数最高。 */
export function pickBestEvent(events, nowMs = Date.now()) {
  if (!events.length) return null;
  const pending = events.filter((e) => e.__ms == null || e.__ms + 60 * MS_MIN >= nowMs);
  const pool = pending.length ? pending : events;
  let best = pool[0];
  for (const e of pool) {
    if (e.score > best.score) best = e;
  }
  return best;
}

/** 去掉内部字段（__ms），输出干净的 JSON。 */
export function toPublicEvent(event) {
  if (!event) return null;
  const { __ms, ...rest } = event;
  return rest;
}
