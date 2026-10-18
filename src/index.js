/**
 * Cloudflare Worker 入口。
 *
 * 路由：
 *   GET /                     接口说明（JSON）
 *   GET /health               健康检查（不访问上游）
 *   GET /v1/glow              主接口：地址 → 火烧云强度
 *   GET /v1/geo               地址解析调试（不消耗预报配额）
 *
 * 设计要点：
 *   - 响应本身不缓存，缓存的是"归一化后的天气包"，所以 now/best 的判断永远新鲜；
 *   - WeatherAPI 是硬依赖，挂了就报错；MET Norway 这个附加源任何失败都只降级；
 *   - 错误一律返回结构化 JSON，前端不用猜 HTTP 语义。
 */

import { ALGORITHM_ID, CACHE_TTL, LIMITS, VERSION } from './config.js';
import { addressCandidates, resolveLocation } from './adapters/geocode.js';
import { fetchLayers } from './adapters/metno.js';
import { fetchForecast } from './adapters/weatherapi.js';
import { analyzeEvents, pickBestEvent, toPublicEvent } from './core/analyze.js';
import { LEVELS, levelPayload } from './core/levels.js';
import { buildSeries } from './core/series.js';
import { readCache, writeCache } from './lib/cache.js';
import { UpstreamError } from './lib/http.js';
import { formatClock, formatDate } from './lib/time.js';

/** 业务错误：带 HTTP 状态码和机器可读 code。 */
class ApiError extends Error {
  constructor(status, code, message, hint = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.hint = hint;
  }
}

/* ------------------------------------------------------------------ 工具 */

const CACHE_HOST = 'https://cache.huoshaoyun.internal';

function cacheUrl(path, params) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v != null) usp.set(k, String(v));
  }
  return `${CACHE_HOST}${path}?${usp.toString()}`;
}

function normalizeAddress(address) {
  return String(address ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function intParam(params, name, fallback) {
  const raw = params.get(name);
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function finiteOrNull(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

const EVENT_ALIASES = {
  all: 'all',
  sunrise: 'sunrise',
  sunset: 'sunset',
  日出: 'sunrise',
  朝霞: 'sunrise',
  早霞: 'sunrise',
  日落: 'sunset',
  晚霞: 'sunset',
  火烧云: 'all',
};

/* --------------------------------------------------------------- 数据装载 */

/**
 * 取一个"归一化天气包"。这是唯一会打上游的地方，也是唯一被缓存的东西。
 * 命中缓存 ≈ 0 次上游调用。
 *
 * 两个上游：WeatherAPI（主：逐小时地面要素 + 日出日落，需要 Key）
 *           MET Norway（附：低/中/高分层云，免 Key，失败自动降级为推断）
 */
async function loadBundle({ key, lat, lon, days, fetchImpl, metnoUserAgent }) {
  // 缓存键里带上算法版本：发版后旧缓存自动失效，
  // 避免"改了代码但接口还是旧结果"这种坑（第一次请求会打上游，之后照常走缓存）。
  const cacheKey = cacheUrl('/bundle', {
    v: VERSION,
    lat: lat.toFixed(3),
    lon: lon.toFixed(3),
    days,
  });

  const hit = await readCache(cacheKey);
  if (hit) return { bundle: hit.value, cached: true };

  const [waSettled, mnSettled] = await Promise.allSettled([
    fetchForecast({ key, lat, lon, days, fetchImpl }),
    fetchLayers({ lat, lon, days, fetchImpl, userAgent: metnoUserAgent }),
  ]);

  if (waSettled.status === 'rejected') throw waSettled.reason;

  const forecast = waSettled.value;
  const metno =
    mnSettled.status === 'fulfilled'
      ? mnSettled.value
      : { ok: false, series: null, error: String(mnSettled.reason?.message ?? mnSettled.reason) };

  const hours = forecast.days.flatMap((d) => d.hours).filter((h) => h.t > 0);
  if (hours.length === 0) {
    throw new ApiError(502, 'UPSTREAM_EMPTY', '上游返回的逐小时数据为空', '换个地点或稍后重试');
  }

  const series = buildSeries({ hours, om: metno.series, aq: null });

  const bundle = {
    location: forecast.location,
    days: forecast.days.map((d) => ({ date: d.date, astro: d.astro, day: d.day })),
    series,
    layered: Boolean(metno.series && metno.layered !== false),
    upstream: {
      weatherapi: { ok: true },
      metno: metno.ok ? { ok: true } : { ok: false, error: metno.error ?? null },
    },
  };

  await writeCache(cacheKey, bundle, CACHE_TTL.forecast);
  return { bundle, cached: false };
}

/* ------------------------------------------------------------------ 路由 */

async function handleGlow(url, env) {
  const params = url.searchParams;

  const address = (params.get('address') ?? params.get('q') ?? '').trim();
  const lat = finiteOrNull(params.get('lat'));
  const lon = finiteOrNull(params.get('lon'));

  // 先判断经纬度是否成对，再判断"有没有给查询条件"——这样错误提示更具体
  if ((lat != null && lon == null) || (lat == null && lon != null)) {
    throw new ApiError(400, 'INVALID_COORDINATE', 'lat 与 lon 必须同时提供');
  }
  if (!address && !(lat != null && lon != null)) {
    throw new ApiError(
      400,
      'MISSING_QUERY',
      '缺少查询参数',
      '用 ?address=北京市朝阳区 或者 ?lat=39.9042&lon=116.4074',
    );
  }
  if (address && address.length > LIMITS.maxAddressLength) {
    throw new ApiError(
      400,
      'ADDRESS_TOO_LONG',
      `地址过长（上限 ${LIMITS.maxAddressLength} 字）`,
      '只传城市或区县名即可，例如「杭州市西湖区」',
    );
  }
  if ((lat != null && (lat < -90 || lat > 90)) || (lon != null && (lon < -180 || lon > 180))) {
    throw new ApiError(400, 'INVALID_COORDINATE', '经纬度超出有效范围');
  }

  const rawDays = intParam(params, 'days', Number(env.DEFAULT_DAYS) || LIMITS.defaultDays);
  const requestedDays = Math.max(1, rawDays);
  const days = Math.min(requestedDays, LIMITS.maxDays);
  const truncatedDays = requestedDays > LIMITS.maxDays;

  const eventRaw = String(params.get('event') ?? 'all').trim().toLowerCase();
  const eventFilter = EVENT_ALIASES[eventRaw] ?? null;
  if (!eventFilter) {
    throw new ApiError(
      400,
      'INVALID_EVENT',
      `event 只能是 all / sunrise / sunset（也接受 朝霞/晚霞）`,
    );
  }

  const withTimeline = params.get('timeline') !== '0' && params.get('timeline') !== 'false';
  const detail = ['brief', 'standard', 'full'].includes(String(params.get('detail') ?? ''))
    ? String(params.get('detail'))
    : 'standard';

  const key = env.WEATHERAPI_KEY;
  if (!key) {
    throw new ApiError(
      500,
      'MISSING_API_KEY',
      '服务端未配置 WEATHERAPI_KEY',
      'wrangler secret put WEATHERAPI_KEY，或在本地 .dev.vars 里配置',
    );
  }

  // 1) 地名 → 坐标
  let loc = null;
  if (lat != null && lon != null) {
    loc = { lat, lon, name: null, region: null, country: null, query: `${lat},${lon}`, resolved: 'coords', tried: [] };
  } else {
    const geoKey = cacheUrl('/geo', { q: normalizeAddress(address) });
    const geoHit = await readCache(geoKey);
    if (geoHit) {
      loc = geoHit.value;
    } else {
      loc = await resolveLocation({ address, key, fetchImpl: env.fetchImpl });
      if (loc) await writeCache(geoKey, loc, CACHE_TTL.geocode);
    }
  }

  if (!loc) {
    throw new ApiError(
      404,
      'LOCATION_NOT_FOUND',
      `没有解析出「${address}」的坐标`,
      '试试只传城市名（北京、杭州、成都），或直接给 lat/lon 参数',
    );
  }

  // 2) 天气数据
  const { bundle, cached } = await loadBundle({
    key,
    lat: loc.lat,
    lon: loc.lon,
    days,
    fetchImpl: env.fetchImpl,
    metnoUserAgent: env.METNO_USER_AGENT,
  });

  const tz = bundle.location?.tz || 'UTC';

  // 3) 评分
  const events = analyzeEvents({
    lat: bundle.location?.lat ?? loc.lat,
    lon: bundle.location?.lon ?? loc.lon,
    tz,
    series: bundle.series,
    days: bundle.days,
    eventFilter,
    withTimeline,
    layered: bundle.layered,
  });

  if (events.length === 0) {
    throw new ApiError(502, 'NO_EVENT', '未能构建出任何日出/日落事件', '请确认该地点当天有正常的日出日落');
  }

  const nowMs = Date.now();
  const bestEvent = pickBestEvent(events, nowMs);
  // 顶层结论给"下一场"，而不是"未来三天最高分"——
  // 否则下午查北京会显示明天的大烧，而今晚其实不烧，非常误导。
  const nextEvent = events.find((e) => e.__ms != null && e.__ms >= nowMs) ?? bestEvent;
  const head = toPublicEvent(nextEvent);
  const best = toPublicEvent(bestEvent);
  const publicEvents = events.map(toPublicEvent);

  const limitations = [];
  if (truncatedDays) limitations.push(`免费接口只支持 ${LIMITS.maxDays} 天预报，days 已截断为 ${days}`);
  if (!bundle.layered) limitations.push('分层云数据源（MET Norway）不可用，已降级为总云量推断，结论精度下降');

  // 事件级 notes 可能和上面的全局说明同义，去重后再拼
  for (const note of [...(head?.notes ?? []), ...(best?.notes ?? [])]) {
    const duplicatedByGlobal = !bundle.layered && note.includes('分层云');
    if (!duplicatedByGlobal && !limitations.includes(note)) limitations.push(note);
  }

  const body = {
    ok: true,
    algorithm: { id: ALGORITHM_ID, version: VERSION },
    generatedAt: new Date(nowMs).toISOString(),
    query: {
      address: address || null,
      lat: loc.lat,
      lon: loc.lon,
      event: eventFilter,
      days,
      detail,
    },
    location: {
      name: bundle.location?.name ?? loc.name,
      region: bundle.location?.region ?? loc.region,
      country: bundle.location?.country ?? loc.country,
      lat: bundle.location?.lat ?? loc.lat,
      lon: bundle.location?.lon ?? loc.lon,
      timezone: tz,
      localtime: bundle.location?.localtime ?? null,
      localDate: formatDate(tz, nowMs),
      localClock: formatClock(tz, nowMs),
      resolvedFrom: loc.resolved,
      resolvedQuery: loc.query,
    },
    // 顶层直接给结论：默认是"下一场"（今晚/明早），best 里放未来三天最值得看的一场
    score: head?.score ?? null,
    level: head?.level ?? null,
    confidence: head?.confidence ?? null,
    best,
    next: head
      ? {
          id: head.id,
          type: head.type,
          label: head.label,
          date: head.date,
          eventTime: head.eventTime,
          peakTime: head.peakTime,
        }
      : null,
    events: publicEvents,
    levels: LEVELS.map(levelPayload),
    dataSources: [
      { name: 'weatherapi', role: 'primary', ok: true, cached },
      { name: 'met.no', role: 'layered-clouds', ok: Boolean(bundle.layered), cached },
    ],
    limitations,
  };

  if (detail === 'brief') {
    body.events = publicEvents.map((e) => ({
      id: e.id,
      type: e.type,
      label: e.label,
      date: e.date,
      eventTime: e.eventTime,
      peakTime: e.peakTime,
      score: e.score,
      level: e.level,
      confidence: e.confidence,
      // 简报也要保留"往哪边看"，这是用户最关心的信息之一
      sun: { direction: e.sun?.direction ?? null, whereToLook: e.sun?.whereToLook ?? null },
      weather: e.weather
        ? {
            cloudLow: e.weather.cloudLow,
            cloudMid: e.weather.cloudMid,
            cloudHigh: e.weather.cloudHigh,
            layered: e.weather.layered,
          }
        : null,
      advice: e.advice,
    }));
    body.best = body.events.find((e) => e.id === best?.id) ?? null;
  }

  return body;
}

async function handleGeo(url, env) {
  const address = (url.searchParams.get('address') ?? url.searchParams.get('q') ?? '').trim();
  if (!address) {
    throw new ApiError(400, 'MISSING_QUERY', '缺少 address 参数');
  }
  const key = env.WEATHERAPI_KEY;
  if (!key) throw new ApiError(500, 'MISSING_API_KEY', '服务端未配置 WEATHERAPI_KEY');

  const candidates = addressCandidates(address);
  const loc = await resolveLocation({ address, key, fetchImpl: env.fetchImpl });

  return {
    ok: true,
    input: address,
    candidatesTried: candidates,
    resolved: loc,
  };
}

/* ------------------------------------------------------------- 响应包装 */

function corsHeaders(env) {
  return {
    'access-control-allow-origin': env?.ALLOW_ORIGIN ?? '*',
    'access-control-allow-methods': 'GET,OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
  };
}

function jsonResponse(body, status, env, extraHeaders = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-algorithm': ALGORITHM_ID,
      ...corsHeaders(env),
      ...extraHeaders,
    },
  });
}

function errorResponse(err, env) {
  if (err instanceof ApiError) {
    return jsonResponse(
      { ok: false, error: { code: err.code, message: err.message, hint: err.hint } },
      err.status,
      env,
    );
  }
  if (err instanceof UpstreamError) {
    const friendly = err.body?.friendly;
    const status = err.status === 401 || err.status === 403 ? 502 : 502;
    return jsonResponse(
      {
        ok: false,
        error: {
          code: err.code ?? 'UPSTREAM_ERROR',
          message: friendly ?? err.message,
          hint:
            err.code === 'WEATHERAPI_2007'
              ? '本月免费额度用完了，等下个月或换一个 key'
              : err.code === 'WEATHERAPI_2006'
                ? '检查 WEATHERAPI_KEY 是否写对（不要带引号或空格）'
                : null,
          upstreamStatus: err.status || null,
        },
      },
      status,
      env,
    );
  }
  return jsonResponse(
    {
      ok: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: '服务内部错误',
        detail: String(err?.message ?? err),
      },
    },
    500,
    env,
  );
}

/* --------------------------------------------------------------- 入口 */

export default {
  async fetch(request, env = {}, _ctx = {}) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }
    if (request.method !== 'GET') {
      return jsonResponse(
        { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: '只支持 GET' } },
        405,
        env,
      );
    }

    const path = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (path === '/' || path === '') {
        return jsonResponse(
          {
            ok: true,
            name: '火烧云强度查询 API',
            version: VERSION,
            algorithm: ALGORITHM_ID,
            usage: 'GET /v1/glow?address=北京市朝阳区&days=2',
            endpoints: {
              'GET /v1/glow': '主接口：address 或 lat+lon',
              'GET /v1/geo': '地名解析调试',
              'GET /health': '健康检查',
            },
            params: {
              address: '地址或城市名（也可用 q）',
              lat: '纬度（与 lon 成对使用）',
              lon: '经度',
              days: `1–${LIMITS.maxDays}，默认 ${LIMITS.defaultDays}`,
              event: 'all | sunrise | sunset（默认 all）',
              timeline: '1/0，是否返回时间轴',
              detail: 'brief | standard | full',
            },
            levels: LEVELS.map((l) => `${l.name}(${l.min}-${Math.min(l.max, 100)})`),
            // 数据源署名要求，详见 README
            attribution: [
              { source: 'WeatherAPI.com', url: 'https://www.weatherapi.com/' },
              {
                source: 'MET Norway',
                license: 'CC BY 4.0',
                url: 'https://www.met.no/en/About-us/terms-of-use',
                note: '分层云数据来自 MET Norway；对外展示时请保留署名',
              },
            ],
          },
          200,
          env,
        );
      }

      if (path === '/health') {
        return jsonResponse(
          {
            ok: true,
            version: VERSION,
            algorithm: ALGORITHM_ID,
            configured: Boolean(env.WEATHERAPI_KEY),
            time: new Date().toISOString(),
          },
          200,
          env,
        );
      }

      if (path === '/v1/glow' || path === '/glow') {
        const body = await handleGlow(url, env);
        return jsonResponse(body, 200, env);
      }

      if (path === '/v1/geo' || path === '/geo') {
        const body = await handleGeo(url, env);
        return jsonResponse(body, 200, env);
      }

      return jsonResponse(
        { ok: false, error: { code: 'NOT_FOUND', message: `没有这个路由: ${path}` } },
        404,
        env,
      );
    } catch (err) {
      return errorResponse(err, env);
    }
  },
};
