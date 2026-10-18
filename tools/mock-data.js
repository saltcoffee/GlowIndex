/**
 * 开发/测试用的合成天气数据（不参与生产打包）。
 *
 * 用途：
 *   1. `node scripts/dev-server.js --mock` 时，让整条链路在完全没有上游凭证的情况下跑起来；
 *   2. 单元测试里构造确定性场景。
 *
 * 生成的数据严格遵循 WeatherAPI / MET Norway 的字段结构，
 * 日期以"该时区的今天"为基准，所以任何时候跑都能看到当天的场景。
 */

import { addDays, clamp0 } from './util.js';
import { sunTimes } from '../src/lib/solar.js';
import { formatClock, parseDateStr, wallToUtc } from '../src/lib/time.js';

/** 每天一套天气"剧本"。数值是刻意调的，方便对照算法输出。 */
export const PROFILES = {
  // 教科书级晚霞：低云少、高云多、空气通透、微风
  big: {
    low: 12, mid: 35, high: 55, rh: 50, temp: 22, spread: 13,
    visKm: 22, wind: 12, gust: 20, precip: 0, chance: 0, aod: 0.16,
    text: 'Partly cloudy',
  },
  // 一般好天气：有云但不多，低云略多
  fair: {
    low: 25, mid: 20, high: 30, rh: 62, temp: 19, spread: 9,
    visKm: 14, wind: 14, gust: 24, precip: 0, chance: 10, aod: 0.42,
    text: 'Scattered clouds',
  },
  // 雨天：低云铺满 + 正在下雨
  rainy: {
    low: 88, mid: 20, high: 10, rh: 93, temp: 15, spread: 3,
    visKm: 5, wind: 18, gust: 32, precip: 2.4, chance: 90, aod: 0.75,
    text: 'Light rain',
  },
  // 阴天：中低云铺满，闷成灰锅盖
  oven: {
    low: 70, mid: 45, high: 15, rh: 86, temp: 16, spread: 3,
    visKm: 8, wind: 10, gust: 18, precip: 0, chance: 40, aod: 0.6,
    text: 'Overcast',
  },
};

const DEFAULT_SCENARIOS = ['big', 'fair', 'rainy'];

/** 该时区"今天"的 YYYY-MM-DD。 */
export function todayIn(tz, atMs = Date.now()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const p = fmt.formatToParts(new Date(atMs));
  const g = (k) => p.find((x) => x.type === k)?.value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}

function hourEpoch(tz, dateStr, hour) {
  const p = parseDateStr(dateStr);
  return wallToUtc(tz, p.y, p.m, p.d, hour, 0, 0);
}

function to12h(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${String(h12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${suffix}`;
}

/** 温度日变化：15 点最高。 */
function diurnal(base, hour, amp = 4) {
  return base + amp * Math.cos(((hour - 15) / 24) * 2 * Math.PI);
}

const round = (v, d = 1) => Math.round(v * 10 ** d) / 10 ** d;

/**
 * 生成一份 WeatherAPI forecast.json 结构的数据。
 */
export function makeWeatherApiForecast({
  lat = 39.9042,
  lon = 116.4074,
  tz = 'Asia/Shanghai',
  name = 'Beijing',
  region = 'Beijing',
  country = 'China',
  days = 3,
  startDate = todayIn(tz),
  scenarios = DEFAULT_SCENARIOS,
} = {}) {
  const forecastday = [];

  for (let i = 0; i < days; i += 1) {
    const date = addDays(startDate, i);
    const profile = PROFILES[scenarios[i % scenarios.length]] ?? PROFILES.fair;
    const st = sunTimes(lat, lon, date, { tz });
    const riseClock = st.sunriseMs ? formatClock(tz, st.sunriseMs) : '06:00';
    const setClock = st.sunsetMs ? formatClock(tz, st.sunsetMs) : '18:00';
    const riseHour = Number(riseClock.slice(0, 2));
    const setHour = Number(setClock.slice(0, 2));

    const hour = [];
    for (let h = 0; h < 24; h += 1) {
      const t = hourEpoch(tz, date, h);
      const temp = diurnal(profile.temp, h);
      const rh = round(clamp0(profile.rh - 6 * Math.cos(((h - 15) / 24) * 2 * Math.PI), 20, 99), 0);
      const isDay = h >= riseHour && h < setHour;
      hour.push({
        time_epoch: Math.floor(t / 1000),
        time: `${date} ${String(h).padStart(2, '0')}:00`,
        temp_c: round(temp, 1),
        temp_f: round(temp * 1.8 + 32, 1),
        is_day: isDay ? 1 : 0,
        condition: { text: profile.text, icon: '', code: 1003 },
        wind_kph: profile.wind,
        wind_degree: 210,
        wind_dir: 'SSW',
        pressure_mb: 1015,
        precip_mm: profile.precip,
        humidity: rh,
        cloud: Math.min(100, Math.round(profile.low * 0.5 + profile.mid * 0.7 + profile.high * 0.6)),
        feelslike_c: round(temp, 1),
        windchill_c: round(temp, 1),
        heatindex_c: round(temp, 1),
        dewpoint_c: round(temp - profile.spread, 1),
        will_it_rain: profile.precip > 0 ? 1 : 0,
        chance_of_rain: profile.chance,
        will_it_snow: 0,
        chance_of_snow: 0,
        vis_km: profile.visKm,
        gust_kph: profile.gust,
        uv: isDay ? 3 : 0,
      });
    }

    forecastday.push({
      date,
      date_epoch: Math.floor(hourEpoch(tz, date, 0) / 1000),
      day: {
        maxtemp_c: round(profile.temp + 4, 1),
        mintemp_c: round(profile.temp - 4, 1),
        avgtemp_c: round(profile.temp, 1),
        maxwind_kph: profile.wind + 6,
        totalprecip_mm: round(profile.precip * 24, 1),
        avgvis_km: profile.visKm,
        avghumidity: profile.rh,
        daily_will_it_rain: profile.precip > 0 ? 1 : 0,
        daily_chance_of_rain: profile.chance,
        condition: { text: profile.text, icon: '', code: 1003 },
      },
      astro: {
        sunrise: to12h(riseClock),
        sunset: to12h(setClock),
        moonrise: '08:12 PM',
        moonset: '09:41 AM',
        moon_phase: 'Waxing Gibbous',
        moon_illumination: 78,
      },
      hour,
    });
  }

  const nowEpoch = Date.now();
  return {
    location: {
      name,
      region,
      country,
      lat,
      lon,
      tz_id: tz,
      localtime_epoch: Math.floor(nowEpoch / 1000),
      localtime: `${todayIn(tz, nowEpoch)} ${formatClock(tz, nowEpoch)}`,
    },
    current: {
      last_updated_epoch: Math.floor(nowEpoch / 1000),
      last_updated: `${startDate} 00:00`,
      temp_c: PROFILES.fair.temp,
      is_day: 1,
      condition: { text: PROFILES.fair.text, icon: '', code: 1003 },
      wind_kph: PROFILES.fair.wind,
      humidity: PROFILES.fair.rh,
      cloud: 50,
      precip_mm: 0,
      vis_km: PROFILES.fair.visKm,
      dewpoint_c: PROFILES.fair.temp - PROFILES.fair.spread,
      gust_kph: PROFILES.fair.gust,
    },
    forecast: { forecastday },
  };
}

/** 生成一份 MET Norway locationforecast 结构的分层云数据。 */
export function makeMetNoForecast({
  lat = 39.9042,
  lon = 116.4074,
  tz = 'Asia/Shanghai',
  days = 3,
  startDate = todayIn(tz),
  scenarios = DEFAULT_SCENARIOS,
} = {}) {
  const timeseries = [];

  for (let i = 0; i < days; i += 1) {
    const date = addDays(startDate, i);
    const profile = PROFILES[scenarios[i % scenarios.length]] ?? PROFILES.fair;
    for (let h = 0; h < 24; h += 1) {
      const t = hourEpoch(tz, date, h);
      const temp = diurnal(profile.temp, h);
      timeseries.push({
        time: `${new Date(t).toISOString().slice(0, 19)}Z`,
        data: {
          instant: {
            details: {
              cloud_area_fraction: Math.min(
                100,
                Math.round(profile.low * 0.5 + profile.mid * 0.7 + profile.high * 0.6),
              ),
              cloud_area_fraction_low: Math.round(profile.low),
              cloud_area_fraction_medium: Math.round(profile.mid),
              cloud_area_fraction_high: Math.round(profile.high),
              relative_humidity: Math.round(
                clamp0(profile.rh - 6 * Math.cos(((h - 15) / 24) * 2 * Math.PI), 20, 99),
              ),
              air_temperature: round(temp, 1),
              dew_point_temperature: round(temp - profile.spread, 1),
              wind_speed: round(profile.wind / 3.6, 1),
            },
          },
          next_1_hours: {
            summary: { symbol_code: 'partlycloudy_day' },
            details: { precipitation_amount: profile.precip },
          },
        },
      });
    }
  }

  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat, 47] },
    properties: {
      meta: {
        updated_at: new Date().toISOString(),
        units: { air_temperature: 'celsius', wind_speed: 'm/s', precipitation_amount: 'mm' },
      },
      timeseries,
    },
  };
}
/** 生成一份 WeatherAPI search.json 的返回。 */
export function makeWeatherApiSearch(q) {
  const s = String(q ?? '');
  // 故意用"整串精确匹配"而不是子串匹配，这样能真正测到地名逐级回退的逻辑
  const table = [
    { match: /^(北京|北京市|beijing|bei jing)$/i, name: 'Beijing', region: 'Beijing', lat: 39.9042, lon: 116.4074 },
    { match: /^(上海|上海市|shanghai)$/i, name: 'Shanghai', region: 'Shanghai', lat: 31.2304, lon: 121.4737 },
    { match: /^(杭州|杭州市|hangzhou)$/i, name: 'Hangzhou', region: 'Zhejiang', lat: 30.2741, lon: 120.1551 },
    { match: /^(成都|成都市|chengdu)$/i, name: 'Chengdu', region: 'Sichuan', lat: 30.5728, lon: 104.0668 },
    { match: /^(广州|广州市|guangzhou)$/i, name: 'Guangzhou', region: 'Guangdong', lat: 23.1291, lon: 113.2644 },
    { match: /^(西安|西安市|xi.?an)$/i, name: "Xi'an", region: 'Shaanxi', lat: 34.3416, lon: 108.9398 },
  ];
  const hit = table.find((t) => t.match.test(s));
  if (!hit) return [];
  return [
    {
      id: hit.lat.toFixed(4),
      name: hit.name,
      region: hit.region,
      country: 'China',
      lat: hit.lat,
      lon: hit.lon,
      url: `https://www.example.com/weather/${hit.name.toLowerCase()}`,
      tz_id: 'Asia/Shanghai',
    },
  ];
}

/**
 * 返回一个可以塞进 env.fetchImpl 的假 fetch。
 */
export function createMockFetch(options = {}) {
  const opts = {
    lat: 39.9042,
    lon: 116.4074,
    tz: 'Asia/Shanghai',
    days: 3,
    today: todayIn(options.tz ?? 'Asia/Shanghai'),
    scenarios: DEFAULT_SCENARIOS,
    ...options,
  };

  return async function mockFetch(url, _init) {
    const u = String(url);
    const json = (body) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    if (u.includes('search.json')) {
      const q = new URL(u).searchParams.get('q') ?? '';
      return json(makeWeatherApiSearch(q));
    }
    if (u.includes('forecast.json')) {
      // 尊重调用方传的 days，让 mock 行为与真实接口一致
      const asked = Number(new URL(u).searchParams.get('days'));
      const d = Number.isFinite(asked) ? Math.min(3, Math.max(1, asked)) : opts.days;
      return json(
        makeWeatherApiForecast({
          ...opts,
          days: d,
          startDate: opts.today,
        }),
      );
    }
    if (u.includes('api.met.no')) {
      // MET Norway 的接口没有 days 参数，按 opts.days 生成即可
      return json(makeMetNoForecast({ ...opts, startDate: opts.today }));
    }
    return new Response(JSON.stringify({ error: { message: `mock 未覆盖的地址: ${u}` } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  };
}
