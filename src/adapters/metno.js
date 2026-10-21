/**
 * MET Norway（挪威气象局）适配器：负责**分层云 + 温湿**，其余要素不碰。
 *
 * 数据分工（刻意划清，避免同一行数据来自不同模型）：
 *   MET Norway  → 低/中/高云量、气温、露点、相对湿度（决定"画布"和"干湿"）
 *   WeatherAPI  → 能见度、风、降水、日出日落（这些 met.no 这个产品不提供）
 *
 * 为什么使用 MET Norway：
 *   - Open-Meteo 的免费 API 限非商业用途，MET Norway 允许商用；
 *   - 无需 Key，直接提供分层云与同源温湿数据。
 *   - MET Norway 数据是 CC BY 4.0：**允许商用**，只需署名；限流只有 20 请求/秒，
 *     没有每日上限；免费、无需 Key。
 *
 * 代价：没有气溶胶 AOD。通透度因子会自动把权重重新归一化到
 *      能见度 / 露点差 / 湿度三项，不影响主流程。
 *
 * 使用条件（来自其 ToS，务必遵守）：
 *   - 请求必须带可识别且**真实**的 User-Agent（应用名 + 联系方式），
 *     伪造或随机字符串会被永久封禁；也不要写 example.com 之类的占位域名，会被 WAF 直接 403；
 *   - 必须遵守 Expires，并在过期后携带 Last-Modified / ETag 做条件重验证；
 *   - 超过 20 请求/秒需要单独申请。
 */

import { CACHE_TTL, HTTP, SOURCES, VERSION } from '../config.js';
import { getJsonWithMeta, UpstreamError, withQuery } from '../lib/http.js';

/** 默认 UA：官方仓库可联系地址；分叉部署可通过环境变量覆盖。 */
export const DEFAULT_USER_AGENT = `GlowIndex/${VERSION} (+https://github.com/saltcoffee/GlowIndex)`;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round4 = (v) => Math.round(Number(v) * 10000) / 10000;

function freshUntilFrom(headers, nowMs) {
  const expiresMs = Date.parse(headers?.expires ?? '');
  const serverDateMs = Date.parse(headers?.date ?? '');

  // 用服务器 Date→Expires 的相对间隔映射到本机时间，避免两边时钟偏差。
  if (Number.isFinite(expiresMs) && Number.isFinite(serverDateMs)) {
    return nowMs + Math.max(0, expiresMs - serverDateMs);
  }
  if (Number.isFinite(expiresMs)) return Math.max(nowMs, expiresMs);

  const maxAge = /(?:^|,)\s*max-age=(\d+)/i.exec(headers?.cacheControl ?? '');
  if (maxAge) return nowMs + Number(maxAge[1]) * 1000;

  return nowMs + CACHE_TTL.metnoFallback * 1000;
}

/**
 * 把 MET Norway 的 locationforecast 响应归一化成"分层云 + 温湿"序列。
 * 能见度/风/降水不在这里取——那些仍以 WeatherAPI 为准。
 * @returns {{ok: boolean, series: object[]|null, layered?: boolean, error?: string}}
 */
export function normalizeMetNo(data) {
  const ts = data?.properties?.timeseries;
  if (!Array.isArray(ts) || ts.length === 0) {
    return { ok: false, series: null, error: 'MET Norway 未返回 timeseries' };
  }

  const series = [];
  for (const point of ts) {
    const t = Date.parse(point?.time ?? '');
    if (Number.isNaN(t)) continue;
    const d = point?.data?.instant?.details ?? {};
    series.push({
      t,
      cloudTotal: num(d.cloud_area_fraction),
      cloudLow: num(d.cloud_area_fraction_low),
      cloudMid: num(d.cloud_area_fraction_medium), // 它叫 medium，我们内部叫 mid
      cloudHigh: num(d.cloud_area_fraction_high),
      // 温湿也来自同一个模型，保证"云"和"干湿"自洽（露点差是通透度的重要输入）
      rh: num(d.relative_humidity),
      tempC: num(d.air_temperature),
      dewC: num(d.dew_point_temperature),
    });
  }

  series.sort((a, b) => a.t - b.t);
  const withLayers = series.filter(
    (r) => r.cloudLow != null && r.cloudMid != null && r.cloudHigh != null,
  );

  return {
    ok: withLayers.length > 0,
    series: series.length ? series : null,
    layered: withLayers.length > 0,
  };
}

/**
 * 拉取分层云。
 * @param {object} params
 * @param {string} [params.userAgent] 必须是可识别的真实 UA
 * @param {{lastModified?: string|null, etag?: string|null}} [params.validators]
 * @param {number} [params.nowMs]
 * @returns {Promise<object>} data 或 not-modified 判别结果，以及可持久化的缓存元数据
 */
export async function fetchLayers({
  lat,
  lon,
  fetchImpl,
  userAgent = DEFAULT_USER_AGENT,
  validators = {},
  nowMs = Date.now(),
}) {
  // 只有 complete 变体带 low/medium/high 三个字段（compact 只有总云量）
  const url = withQuery(`${SOURCES.metno}/complete`, {
    lat: round4(lat),
    lon: round4(lon),
  });

  const headers = { 'user-agent': userAgent };
  if (validators.lastModified) headers['if-modified-since'] = validators.lastModified;
  if (validators.etag) headers['if-none-match'] = validators.etag;

  const response = await getJsonWithMeta(url, {
    timeoutMs: HTTP.metnoTimeoutMs,
    retries: HTTP.retries,
    retryDelayMs: HTTP.retryDelayMs,
    fetchImpl,
    headers,
    acceptedStatuses: [304],
  });

  const notModified = response.status === 304;
  const metadata = {
    freshUntil: freshUntilFrom(response.headers, nowMs),
    lastModified:
      response.headers.lastModified ?? (notModified ? validators.lastModified ?? null : null),
    etag: response.headers.etag ?? (notModified ? validators.etag ?? null : null),
  };

  if (notModified) {
    if (!validators.lastModified && !validators.etag) {
      throw new UpstreamError('MET Norway 返回 304，但本地没有可复用的缓存验证器', {
        status: 304,
      });
    }
    return { kind: 'not-modified', ...metadata };
  }

  return { kind: 'data', result: normalizeMetNo(response.data), ...metadata };
}
