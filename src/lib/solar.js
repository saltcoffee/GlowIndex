/**
 * 太阳位置计算（NOAA / Meeus 低精度算法，无任何依赖）。
 *
 * 为什么必须自己算：火烧云的核心条件是"太阳刚好在地平线附近"，
 * 需要一个能给出任意时刻太阳高度角/方位角的函数，
 * 而天气接口只给日出日落两个时间点。
 *
 * 精度：高度角误差 < 0.02°，日出日落误差 < 1 分钟，完全够评分用。
 */

import { clamp, mod } from './mathx.js';

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const MS_PER_DAY = 86400000;
const J2000 = 2451545.0;

/** 太阳圆盘中心几何高度角在日出日落时的标准取值（含大气折射 34′ 与半径 16′）。 */
export const SUNRISE_ALTITUDE = -0.833;

/** epoch ms → 儒略日 */
export function julianFromMs(ms) {
  return ms / MS_PER_DAY + 2440587.5;
}

/** 公历日历日 → 儒略日（支持小数小时）。 */
export function julianDay(year, month, day, hoursUtc = 0) {
  let y = year;
  let m = month;
  if (m <= 2) {
    y -= 1;
    m += 12;
  }
  const a = Math.floor(y / 100);
  const b = 2 - a + Math.floor(a / 4); // 格里高利历修正
  return (
    Math.floor(365.25 * (y + 4716)) +
    Math.floor(30.6001 * (m + 1)) +
    day +
    b -
    1524.5 +
    hoursUtc / 24
  );
}

/**
 * 由儒略日求太阳赤纬与均时差。
 * @returns {{declination: number, eqTime: number, T: number}} 赤纬单位为度，均时差为分钟
 */
export function sunPositionJD(jd) {
  const T = (jd - J2000) / 36525;

  // 几何平黄经、平近点角、偏心率
  const L0 = mod(280.46646 + T * (36000.76983 + T * 0.0003032), 360);
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);

  // 中心差 → 真黄经
  const Mr = M * RAD;
  const C =
    Math.sin(Mr) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
    Math.sin(2 * Mr) * (0.019993 - 0.000101 * T) +
    Math.sin(3 * Mr) * 0.000289;
  const trueLong = L0 + C;

  // 黄赤交角（含章动修正）
  const omega = 125.04 - 1934.136 * T;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  const meanObliq =
    23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = meanObliq + 0.00256 * Math.cos(omega * RAD);
  const declination = Math.asin(Math.sin(eps * RAD) * Math.sin(lambda * RAD)) * DEG;

  // 均时差（分钟）
  const y = Math.tan((eps * RAD) / 2) ** 2;
  const L0r = L0 * RAD;
  const eqTime =
    4 *
    DEG *
    (y * Math.sin(2 * L0r) -
      2 * e * Math.sin(Mr) +
      4 * e * y * Math.sin(Mr) * Math.cos(2 * L0r) -
      0.5 * y * y * Math.sin(4 * L0r) -
      1.25 * e * e * Math.sin(2 * Mr));

  return { declination, eqTime, T };
}

/** 大气折射近似（度），用于把几何高度角换成目视高度角。 */
export function refractionDeg(elevation) {
  if (elevation > 85) return 0;
  const te = Math.tan(elevation * RAD);
  let r;
  if (elevation > 5) r = 58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5;
  else if (elevation > -0.575) r = 1735 + elevation * (-518.2 + elevation * (103.4 + elevation * (-12.79 + elevation * 0.711)));
  else r = -20.772 / te;
  return r / 3600;
}

/**
 * 任意时刻的太阳高度角与方位角。
 * @param {number} latDeg 纬度
 * @param {number} lonDeg 经度（东正西负）
 * @param {number} ms epoch ms
 * @returns {{elevation: number, azimuth: number, declination: number, eqTime: number}}
 *          elevation 为几何高度角（度），azimuth 为自正北顺时针（度）
 */
export function sunElevationAzimuth(latDeg, lonDeg, ms) {
  const jd = julianFromMs(ms);
  const { declination, eqTime } = sunPositionJD(jd);

  const minutesOfUtcDay = (mod(ms, MS_PER_DAY) / 60000) | 0;
  const trueSolarTime = mod(minutesOfUtcDay + eqTime + 4 * lonDeg, 1440);
  let hourAngle = trueSolarTime / 4 - 180;
  if (hourAngle < -180) hourAngle += 360;

  const lat = latDeg * RAD;
  const dec = declination * RAD;
  const ha = hourAngle * RAD;

  const cosZenith =
    Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(ha);
  const zenith = Math.acos(clamp(cosZenith, -1, 1)) * DEG;
  const elevation = 90 - zenith;

  const azimuth = mod(
    Math.atan2(
      Math.sin(ha),
      Math.cos(ha) * Math.sin(lat) - Math.tan(dec) * Math.cos(lat),
    ) *
      DEG +
      180,
    360,
  );

  return { elevation, azimuth, declination, eqTime };
}

/** 大气层外的太阳直射辐射（给"光照潜力"参考用，不是评分必需）。 */
export function extraterrestrialWm2(ms) {
  const jd = julianFromMs(ms);
  const n = jd - 2451545.0;
  const g = mod(357.529 + 0.98560028 * n, 360) * RAD;
  return 1361 * (1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g));
}

/**
 * 某地某日的日出/日落（以及极昼极夜判断）。
 * @param {string} dateStr "YYYY-MM-DD"（按该地本地日期理解时请传 tz）
 * @param {{tz?: string, altitude?: number}} [opts]
 * @returns {{kind: 'normal'|'polar-day'|'polar-night', sunriseMs: number|null,
 *            sunsetMs: number|null, solarNoonMs: number, declination: number, dayLengthMin: number}}
 */
export function sunTimes(latDeg, lonDeg, dateStr, opts = {}) {
  const { tz = null, altitude = SUNRISE_ALTITUDE } = opts;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr ?? ''));
  if (!m) throw new Error(`invalid date: ${dateStr}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dayStartMs = Date.UTC(y, mo - 1, d);

  // 两次迭代：先用当日 12 时的太阳参数，再用事件时刻的参数修正
  let { declination, eqTime } = sunPositionJD(julianDay(y, mo, d, 12));
  let riseMin = 0;
  let setMin = 0;
  let kind = 'normal';

  for (let iter = 0; iter < 2; iter += 1) {
    const cosHA =
      Math.cos((90 - altitude) * RAD) / (Math.cos(latDeg * RAD) * Math.cos(declination * RAD)) -
      Math.tan(latDeg * RAD) * Math.tan(declination * RAD);

    if (cosHA > 1) {
      kind = 'polar-night';
      riseMin = null;
      setMin = null;
    } else if (cosHA < -1) {
      kind = 'polar-day';
      riseMin = null;
      setMin = null;
    } else {
      kind = 'normal';
      const HA = Math.acos(cosHA) * DEG;
      riseMin = 720 - 4 * (lonDeg + HA) - eqTime;
      setMin = 720 - 4 * (lonDeg - HA) - eqTime;
    }
    if (kind !== 'normal') break;

    const mid = (riseMin + setMin) / 2;
    const probe = sunPositionJD(julianFromMs(dayStartMs + mid * 60000));
    declination = probe.declination;
    eqTime = probe.eqTime;
  }

  const solarNoonMs = dayStartMs + (720 - 4 * lonDeg - eqTime) * 60000;
  let sunriseMs = kind === 'normal' ? dayStartMs + riseMin * 60000 : null;
  let sunsetMs = kind === 'normal' ? dayStartMs + setMin * 60000 : null;

  // 事件落在 UTC 前一天/后一天是常态（尤其东八区），按本地日期校正
  if (tz && sunriseMs != null) sunriseMs = alignDay(sunriseMs, tz, `${m[1]}-${m[2]}-${m[3]}`);
  if (tz && sunsetMs != null) sunsetMs = alignDay(sunsetMs, tz, `${m[1]}-${m[2]}-${m[3]}`);

  return {
    kind,
    sunriseMs,
    sunsetMs,
    solarNoonMs,
    declination,
    dayLengthMin: sunriseMs != null && sunsetMs != null ? (sunsetMs - sunriseMs) / 60000 : null,
  };
}

/** 找出离目标时刻最近、且在同一本地日期的那个事件。 */
function alignDay(ms, tz, dateStr) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const localDate = (t) => {
    const p = fmt.formatToParts(new Date(t));
    const g = (k) => p.find((x) => x.type === k)?.value;
    return `${g('year')}-${g('month')}-${g('day')}`;
  };
  let t = ms;
  for (let i = 0; i < 3; i += 1) {
    const cur = localDate(t);
    if (cur === dateStr) return t;
    t += cur < dateStr ? 86400000 : -86400000;
  }
  return ms;
}
