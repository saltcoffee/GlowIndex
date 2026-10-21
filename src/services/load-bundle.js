/**
 * 天气包应用服务：协调两个上游及其不同的缓存契约。
 *
 * WeatherAPI 的归一化预报缓存 25 分钟；MET Norway 单独遵守其响应的
 * Expires / Last-Modified / ETag。每次请求只即时合并两份独立数据，
 * 不缓存合并结果，避免任一来源的 TTL 遮蔽另一来源的刷新语义。
 */

import { fetchLayers } from '../adapters/metno.js';
import { fetchForecast } from '../adapters/weatherapi.js';
import { CACHE_TTL, VERSION } from '../config.js';
import { buildSeries } from '../core/series.js';
import { createCacheKey, readCache, writeCache } from '../lib/cache.js';
import { ApiError } from '../lib/errors.js';

const dayMs = 86400000;
const coordinateKey = (value) => (Math.round(Number(value) * 10000) / 10000).toFixed(4);

function limitLayerDays(result, days, nowMs) {
  if (!result?.series || !days) return { ...result };
  const until = nowMs + (days + 1) * dayMs;
  return { ...result, series: result.series.filter((row) => row.t <= until) };
}

/** 读取或条件重验证 MET Norway 数据，再按本次请求天数做不可变裁剪。 */
export async function loadMetNo({
  lat,
  lon,
  days,
  fetchImpl,
  userAgent,
  nowMs = Date.now(),
}) {
  const key = createCacheKey('metno-v1', {
    lat: coordinateKey(lat),
    lon: coordinateKey(lon),
  });
  const hit = await readCache(key);
  const stored = hit?.value?.result ? hit.value : null;

  if (stored && Number(stored.freshUntil) > nowMs) {
    return { ...limitLayerDays(stored.result, days, nowMs), cached: true };
  }

  const response = await fetchLayers({
    lat,
    lon,
    fetchImpl,
    userAgent,
    nowMs,
    validators: stored
      ? { lastModified: stored.lastModified ?? null, etag: stored.etag ?? null }
      : {},
  });

  const result = response.kind === 'not-modified' ? stored?.result : response.result;
  if (!result) {
    throw new ApiError(502, 'UPSTREAM_EMPTY', 'MET Norway 返回 304，但本地缓存不可用');
  }

  // 验证器至少要保留到上游声明的 freshness 结束，额外 60 秒吸收时钟与取整误差。
  const freshnessTtl = Number.isFinite(response.freshUntil)
    ? Math.ceil(Math.max(0, response.freshUntil - nowMs) / 1000) + 60
    : 0;
  const storageTtl = Math.max(CACHE_TTL.metnoMetadata, freshnessTtl);

  await writeCache(
    key,
    {
      result,
      freshUntil: response.freshUntil,
      lastModified: response.lastModified,
      etag: response.etag,
      checkedAt: nowMs,
    },
    storageTtl,
  );

  return {
    ...limitLayerDays(result, days, nowMs),
    cached: response.kind === 'not-modified',
  };
}

/** 读取或刷新 WeatherAPI 的归一化预报；缓存版本跟随算法版本失效。 */
async function loadWeatherApi({ key, lat, lon, days, fetchImpl }) {
  const cacheKey = createCacheKey('weatherapi-v1', {
    v: VERSION,
    lat: lat.toFixed(3),
    lon: lon.toFixed(3),
    days,
  });
  const hit = await readCache(cacheKey);
  if (hit) return { forecast: hit.value, cached: true };

  const forecast = await fetchForecast({ key, lat, lon, days, fetchImpl });
  if (!forecast.days.some((day) => day.hours.some((hour) => hour.t > 0))) {
    throw new ApiError(502, 'UPSTREAM_EMPTY', '上游返回的逐小时数据为空', '换个地点或稍后重试');
  }
  await writeCache(cacheKey, forecast, CACHE_TTL.forecast);
  return { forecast, cached: false };
}

/** 取得一个用于评分的归一化天气包。 */
export async function loadBundle({
  key,
  lat,
  lon,
  days,
  fetchImpl,
  metnoUserAgent,
  nowMs = Date.now(),
}) {
  const [waSettled, mnSettled] = await Promise.allSettled([
    loadWeatherApi({ key, lat, lon, days, fetchImpl }),
    loadMetNo({ lat, lon, days, fetchImpl, userAgent: metnoUserAgent, nowMs }),
  ]);

  if (waSettled.status === 'rejected') throw waSettled.reason;

  const weatherapi = waSettled.value;
  const forecast = weatherapi.forecast;
  const metno =
    mnSettled.status === 'fulfilled'
      ? mnSettled.value
      : {
          ok: false,
          series: null,
          cached: false,
          error: String(mnSettled.reason?.message ?? mnSettled.reason),
        };

  const hours = forecast.days.flatMap((day) => day.hours).filter((hour) => hour.t > 0);
  const series = buildSeries({ hours, om: metno.series, aq: null });
  const bundle = {
    location: forecast.location,
    days: forecast.days.map((day) => ({ date: day.date, astro: day.astro, day: day.day })),
    series,
    layered: Boolean(metno.series && metno.layered !== false),
    upstream: {
      weatherapi: { ok: true, cached: weatherapi.cached },
      metno: metno.ok
        ? { ok: true, cached: Boolean(metno.cached) }
        : { ok: false, cached: Boolean(metno.cached), error: metno.error ?? null },
    },
  };

  return { bundle };
}
