/** 时区与时间格式化。

关键约定：算法内部所有时刻一律用 UTC 毫秒（epoch ms），
只在"给用户看"和"对齐上游的本地时间"时做时区换算。
这样做可以完全避开 DST、跨日、半小时时区（如印度 +5:30）这些坑。
 */

const MS_MIN = 60000;

/**
 * 某时区在某个时刻相对 UTC 的偏移（毫秒，东八区 = +28800000）。
 * 实测走 Intl，能正确处理夏令时；出错时退回 0。
 */
export function tzOffsetMs(tz, atMs) {
  if (!tz) return 0;
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const parts = {};
    for (const p of dtf.formatToParts(new Date(atMs))) {
      if (p.type !== 'literal') parts[p.type] = p.value;
    }
    const asUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    const offset = asUtc - Math.floor(atMs / 1000) * 1000;
    return Math.round(offset / MS_MIN) * MS_MIN;
  } catch {
    return 0;
  }
}

/** UTC 毫秒 → 该时区的 "HH:MM"。 */
export function formatClock(tz, atMs, offsetOverride = null) {
  const offset = offsetOverride == null ? tzOffsetMs(tz, atMs) : offsetOverride;
  const d = new Date(atMs + offset);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/** UTC 毫秒 → 该时区的 "YYYY-MM-DD"。 */
export function formatDate(tz, atMs, offsetOverride = null) {
  const offset = offsetOverride == null ? tzOffsetMs(tz, atMs) : offsetOverride;
  const d = new Date(atMs + offset);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** "YYYY-MM-DD" → {y, m, d}；格式不对返回 null。 */
export function parseDateStr(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr ?? '').trim());
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

/** "YYYY-MM-DD" 加减天数。 */
export function addDays(dateStr, n) {
  const p = parseDateStr(dateStr);
  if (!p) return null;
  const t = Date.UTC(p.y, p.m - 1, p.d) + n * 86400000;
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/**
 * 本地"墙上时间" → UTC 毫秒。
 * 用两次逼近处理夏令时切换那天的歧义，够用了。
 */
export function wallToUtc(tz, y, mo, d, hh = 0, mi = 0, ss = 0) {
  const guess = Date.UTC(y, mo - 1, d, hh, mi, ss);
  const off1 = tzOffsetMs(tz, guess);
  let t = guess - off1;
  const off2 = tzOffsetMs(tz, t);
  if (off2 !== off1) t = guess - off2;
  return t;
}

/** 把 UTC 毫秒调整到"该时区里日期等于 dateStr"的同一天。 */
export function alignToLocalDate(atMs, tz, dateStr) {
  if (!tz || !dateStr) return atMs;
  let t = atMs;
  for (let i = 0; i < 3; i += 1) {
    const cur = formatDate(tz, t);
    if (cur === dateStr) return t;
    const curP = parseDateStr(cur);
    const wantP = parseDateStr(dateStr);
    if (!curP || !wantP) return t;
    const diffDays = Math.round(
      (Date.UTC(wantP.y, wantP.m - 1, wantP.d) - Date.UTC(curP.y, curP.m - 1, curP.d)) / 86400000,
    );
    t += diffDays * 86400000;
  }
  return t;
}

/** 解析 WeatherAPI astro 的 "06:24 AM" / "07:41 PM"。 */
export function parseAstroClock(str) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(String(str ?? '').trim());
  if (!m) return null;
  let hh = Number(m[1]) % 12;
  if (m[3].toUpperCase() === 'PM') hh += 12;
  return { hh, mm: Number(m[2]) };
}

const pad2 = (n) => String(n).padStart(2, '0');
