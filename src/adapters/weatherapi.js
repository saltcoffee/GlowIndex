/**
 * WeatherAPI 适配器：主数据源（当前天气 + 逐小时预报 + 日出日落）。
 *
 * 只用免费额度内的 3 天预报 + 地名搜索，不请求 aqi/alerts，
 * 以减少响应体积和配额消耗。
 */

import { SOURCES, HTTP } from '../config.js';
import { getJson, withQuery, UpstreamError } from '../lib/http.js';

/** WeatherAPI 错误码 → 中文说明。 */
const ERROR_MESSAGES = {
  1002: '未提供 API Key（请检查 WEATHERAPI_KEY 环境变量 / Secret）',
  1003: '缺少查询参数 q',
  1005: '请求的地址无效',
  1006: '找不到匹配的地点',
  2006: 'API Key 无效',
  2007: 'API 调用次数已超出本月配额',
  2008: 'API Key 已被停用',
  2009: 'API Key 已失效',
  9999: 'WeatherAPI 内部错误',
};

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** 这些错误码意味着"继续重试/继续换关键词都没意义"，必须立刻上抛。 */
const FATAL_CODES = new Set([
  'WEATHERAPI_1002',
  'WEATHERAPI_2006',
  'WEATHERAPI_2007',
  'WEATHERAPI_2008',
  'WEATHERAPI_2009',
  'WEATHERAPI_9999',
]);

/**
 * 从 WeatherAPI 的错误体里抽出可读信息并抛错。
 * WeatherAPI 用 401/403 返回业务错误码，所以不能只看 HTTP status。
 */
function throwIfApiError(data, status) {
  const err = data?.error;
  if (!err) return;
  const code = Number(err.code);
  throw new UpstreamError(`WeatherAPI ${code}: ${err.message}`, {
    code: `WEATHERAPI_${code}`,
    status,
    body: { apiCode: code, apiMessage: err.message, friendly: ERROR_MESSAGES[code] ?? null },
  });
}

/**
 * 把 WeatherAPI 的原始响应归一化成内部结构。
 * 单独导出是为了让测试可以脱离网络直接验证字段映射。
 */
export function normalizeForecast(data) {
  const loc = data?.location;
  if (!loc) {
    throw new UpstreamError('WeatherAPI 响应缺少 location', { code: 'BAD_PAYLOAD' });
  }

  const days = (data?.forecast?.forecastday ?? []).map((fd) => ({
    date: fd.date,
    astro: {
      sunrise: fd?.astro?.sunrise ?? null,
      sunset: fd?.astro?.sunset ?? null,
      moonPhase: fd?.astro?.moon_phase ?? null,
      moonIllumination: num(fd?.astro?.moon_illumination),
    },
    hours: (fd?.hour ?? []).map((h) => ({
      t: (h.time_epoch ?? 0) * 1000,
      cloudTotal: num(h.cloud),
      rh: num(h.humidity),
      visKm: num(h.vis_km),
      precipMm: num(h.precip_mm),
      chanceRain: num(h.chance_of_rain),
      windKph: num(h.wind_kph),
      gustKph: num(h.gust_kph),
      tempC: num(h.temp_c),
      dewC: num(h.dewpoint_c),
      uv: num(h.uv),
      isDay: h.is_day === 1,
      condition: h?.condition?.text ?? null,
      conditionCode: num(h?.condition?.code),
    })),
    day: {
      maxtempC: num(fd?.day?.maxtemp_c),
      mintempC: num(fd?.day?.mintemp_c),
      avgHumidity: num(fd?.day?.avghumidity),
      maxWindKph: num(fd?.day?.maxwind_kph),
      totalPrecipMm: num(fd?.day?.totalprecip_mm),
      avgVisKm: num(fd?.day?.avgvis_km),
      chanceOfRain: num(fd?.day?.daily_chance_of_rain),
      condition: fd?.day?.condition?.text ?? null,
    },
  }));

  return {
    location: {
      name: loc.name ?? null,
      region: loc.region ?? null,
      country: loc.country ?? null,
      lat: num(loc.lat),
      lon: num(loc.lon),
      tz: loc.tz_id ?? 'UTC',
      localtimeEpoch: num(loc.localtime_epoch),
      localtime: loc.localtime ?? null,
    },
    current: data?.current
      ? {
          t: (data.current.last_updated_epoch ?? 0) * 1000,
          tempC: num(data.current.temp_c),
          cloudTotal: num(data.current.cloud),
          rh: num(data.current.humidity),
          visKm: num(data.current.vis_km),
          precipMm: num(data.current.precip_mm),
          windKph: num(data.current.wind_kph),
          gustKph: num(data.current.gust_kph),
          dewC: num(data.current.dewpoint_c),
          condition: data.current?.condition?.text ?? null,
          isDay: data.current.is_day === 1,
        }
      : null,
    days,
  };
}

/**
 * 拉取预报。
 * @returns {Promise<{location: object, days: object[]}>}
 */
export async function fetchForecast({ key, lat, lon, days, fetchImpl, lang = 'zh' }) {
  if (!key) {
    throw new UpstreamError('未配置 WEATHERAPI_KEY', { code: 'MISSING_API_KEY' });
  }

  const url = withQuery(`${SOURCES.weatherApi}/forecast.json`, {
    key,
    q: `${round4(lat)},${round4(lon)}`,
    days,
    aqi: 'no',
    alerts: 'no',
    lang,
  });

  let data;
  try {
    data = await getJson(url, {
      timeoutMs: HTTP.weatherApiTimeoutMs,
      retries: HTTP.retries,
      retryDelayMs: HTTP.retryDelayMs,
      fetchImpl,
    });
  } catch (err) {
    // 401/403 的响应体里其实带着业务错误码，转成中文提示更有用
    if (err instanceof UpstreamError && err.body?.error) {
      throwIfApiError({ error: err.body.error }, err.status);
    }
    throw err;
  }

  throwIfApiError(data, 200);
  return normalizeForecast(data);
}

/**
 * 地名/地址解析。逐级放宽查询串，直到命中为止。
 * @returns {Promise<{candidates: object[], tried: string[], query: string}|null>}
 */
export async function searchLocations({ key, candidates, fetchImpl }) {
  if (!key) throw new UpstreamError('未配置 WEATHERAPI_KEY', { code: 'MISSING_API_KEY' });

  const tried = [];
  for (const q of candidates) {
    tried.push(q);
    const url = withQuery(`${SOURCES.weatherApi}/search.json`, { key, q, lang: 'zh' });
    let data;
    try {
      data = await getJson(url, {
        timeoutMs: HTTP.weatherApiTimeoutMs,
        retries: 0,
        fetchImpl,
      });
    } catch (err) {
      if (
        err instanceof UpstreamError &&
        (FATAL_CODES.has(err.code) || err.status === 429 || err.status >= 500 || err.status === 0)
      ) {
        throw err;
      }
      continue;
    }
    if (Array.isArray(data) && data.length > 0) {
      return { candidates: data, tried, query: q };
    }
  }
  return null;
}

function round4(v) {
  return Math.round(Number(v) * 10000) / 10000;
}
