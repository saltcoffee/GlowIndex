import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { clearMemoryCache } from '../src/lib/cache.js';
import { loadBundle, loadMetNo } from '../src/services/load-bundle.js';
import { makeMetNoForecast, makeWeatherApiForecast } from '../tools/mock-data.js';

const minute = 60000;

beforeEach(() => clearMemoryCache());

function metResponse(body, { nowMs, expiresInMin, lastModified = null, status = 200 } = {}) {
  const headers = {};
  if (nowMs != null) headers.date = new Date(nowMs).toUTCString();
  if (nowMs != null && expiresInMin != null) {
    headers.expires = new Date(nowMs + expiresInMin * minute).toUTCString();
  }
  if (lastModified) headers['last-modified'] = lastModified;
  return new Response(status === 304 ? null : JSON.stringify(body), { status, headers });
}

describe('MET Norway 独立缓存', () => {
  it('主源的空预报不会污染缓存，恢复后下一次请求即可成功', async () => {
    let weatherCalls = 0;
    const fetchImpl = async (url) => {
      if (new URL(url).hostname !== 'api.weatherapi.com') {
        return new Response(JSON.stringify(makeMetNoForecast({ days: 3 })));
      }
      weatherCalls += 1;
      const raw = makeWeatherApiForecast({ days: 3 });
      if (weatherCalls === 1) raw.forecast.forecastday = [];
      return new Response(JSON.stringify(raw));
    };
    const params = { key: 'test-key', lat: 39.9, lon: 116.4, days: 2, fetchImpl };

    await assert.rejects(loadBundle(params), (error) => error.code === 'UPSTREAM_EMPTY');
    const recovered = await loadBundle(params);

    assert.equal(weatherCalls, 2);
    assert.ok(recovered.bundle.series.length > 0);
    assert.equal(recovered.bundle.upstream.weatherapi.cached, false);
  });

  it('主源仍在 25 分钟缓存期时，MET 到期仍独立条件重验证', async () => {
    const nowMs = Date.now();
    const lastModified = 'Tue, 20 Oct 2026 23:00:00 GMT';
    let weatherCalls = 0;
    let metCalls = 0;
    let validator = null;
    const fetchImpl = async (url, init) => {
      if (new URL(url).hostname === 'api.weatherapi.com') {
        weatherCalls += 1;
        return new Response(JSON.stringify(makeWeatherApiForecast({ days: 3 })));
      }
      metCalls += 1;
      if (metCalls === 1) {
        return metResponse(makeMetNoForecast({ days: 3 }), {
          nowMs, expiresInMin: 1, lastModified,
        });
      }
      validator = init.headers['if-modified-since'];
      return metResponse(null, {
        nowMs: nowMs + 2 * minute, expiresInMin: 60, status: 304,
      });
    };
    const params = { key: 'test-key', lat: 39.9, lon: 116.4, days: 2, fetchImpl };

    const first = await loadBundle({ ...params, nowMs });
    const second = await loadBundle({ ...params, nowMs: nowMs + 2 * minute });

    assert.equal(weatherCalls, 1);
    assert.equal(metCalls, 2);
    assert.equal(validator, lastModified);
    assert.equal(first.bundle.upstream.weatherapi.cached, false);
    assert.equal(second.bundle.upstream.weatherapi.cached, true);
    assert.equal(second.bundle.upstream.metno.cached, true);
    assert.deepEqual(second.bundle.series, first.bundle.series);
  });

  it('在 Expires 前复用同一份数据，并按请求天数独立裁剪', async () => {
    const nowMs = Date.now();
    const raw = makeMetNoForecast({ days: 5 });
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return metResponse(raw, { nowMs, expiresInMin: 90 });
    };

    const oneDay = await loadMetNo({ lat: 39.9, lon: 116.4, days: 1, fetchImpl, nowMs });
    const threeDays = await loadMetNo({
      lat: 39.9,
      lon: 116.4,
      days: 3,
      fetchImpl,
      nowMs: nowMs + minute,
    });

    assert.equal(calls, 1);
    assert.equal(oneDay.cached, false);
    assert.equal(threeDays.cached, true);
    assert.ok(oneDay.series.length < threeDays.series.length);
  });

  it('过期后带 Last-Modified 重验证，304 继续复用原序列', async () => {
    const nowMs = Date.now();
    const lastModified = 'Tue, 20 Oct 2026 23:00:00 GMT';
    const raw = makeMetNoForecast({ days: 3 });
    let calls = 0;
    let conditionalHeader = null;
    const fetchImpl = async (_url, init) => {
      calls += 1;
      if (calls === 1) {
        return metResponse(raw, { nowMs, expiresInMin: 1, lastModified });
      }
      conditionalHeader = init.headers['if-modified-since'];
      return metResponse(null, {
        nowMs: nowMs + 2 * minute,
        expiresInMin: 60,
        lastModified,
        status: 304,
      });
    };

    const first = await loadMetNo({ lat: 39.9, lon: 116.4, days: 2, fetchImpl, nowMs });
    const second = await loadMetNo({
      lat: 39.9,
      lon: 116.4,
      days: 2,
      fetchImpl,
      nowMs: nowMs + 2 * minute,
    });

    assert.equal(calls, 2);
    assert.equal(conditionalHeader, lastModified);
    assert.equal(second.cached, true);
    assert.deepEqual(second.series, first.series);
  });

  it('过期后收到 200 时用新响应替换旧序列', async () => {
    const nowMs = Date.now();
    const firstRaw = makeMetNoForecast({ days: 3, scenarios: ['big'] });
    const updatedRaw = makeMetNoForecast({ days: 3, scenarios: ['rainy'] });
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return metResponse(calls === 1 ? firstRaw : updatedRaw, {
        nowMs: nowMs + (calls - 1) * 2 * minute,
        expiresInMin: calls === 1 ? 1 : 60,
        lastModified:
          calls === 1
            ? 'Tue, 20 Oct 2026 22:00:00 GMT'
            : 'Tue, 20 Oct 2026 23:00:00 GMT',
      });
    };

    const first = await loadMetNo({ lat: 23.1, lon: 113.3, days: 2, fetchImpl, nowMs });
    const updated = await loadMetNo({
      lat: 23.1,
      lon: 113.3,
      days: 2,
      fetchImpl,
      nowMs: nowMs + 2 * minute,
    });

    assert.equal(calls, 2);
    assert.equal(updated.cached, false);
    assert.notEqual(updated.series[0].cloudLow, first.series[0].cloudLow);
    assert.equal(updated.series[0].cloudLow, 88);
  });

  it('缺少有效缓存头时采用一小时兜底，不会高频重拉', async () => {
    const nowMs = Date.now();
    const raw = makeMetNoForecast({ days: 3 });
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return new Response(JSON.stringify(raw), { status: 200 });
    };

    await loadMetNo({ lat: 31.2, lon: 121.5, days: 2, fetchImpl, nowMs });
    await loadMetNo({
      lat: 31.2,
      lon: 121.5,
      days: 2,
      fetchImpl,
      nowMs: nowMs + 59 * minute,
    });
    assert.equal(calls, 1);

    await loadMetNo({
      lat: 31.2,
      lon: 121.5,
      days: 2,
      fetchImpl,
      nowMs: nowMs + 61 * minute,
    });
    assert.equal(calls, 2);
  });
});
