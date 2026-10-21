import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fetchLayers, normalizeMetNo } from '../src/adapters/metno.js';
import { makeMetNoForecast } from '../tools/mock-data.js';

describe('MET Norway 适配器', () => {
  it('把 timeseries 归一化成"只有分层云"的序列', () => {
    const raw = makeMetNoForecast({
      tz: 'Asia/Shanghai',
      days: 1,
      startDate: '2026-10-18',
      scenarios: ['big'],
    });
    const r = normalizeMetNo(raw);

    assert.equal(r.ok, true);
    assert.equal(r.layered, true);
    assert.equal(r.series.length, 24);

    const row = r.series[0];
    assert.equal(row.cloudLow, 12);
    assert.equal(row.cloudMid, 35);
    assert.equal(row.cloudHigh, 55);
    // 只带"分层云 + 温湿"，能见度/风/降水仍由 WeatherAPI 提供，避免双份数据打架
    assert.deepEqual(Object.keys(row).sort(), [
      'cloudHigh',
      'cloudLow',
      'cloudMid',
      'cloudTotal',
      'dewC',
      'rh',
      't',
      'tempC',
    ]);
  });

  it('缺少低/中/高字段时判定为不可用（而不是给 0）', () => {
    const raw = {
      properties: {
        timeseries: [
          {
            time: '2026-10-18T00:00:00Z',
            data: { instant: { details: { cloud_area_fraction: 40 } } },
          },
        ],
      },
    };
    const r = normalizeMetNo(raw);
    assert.equal(r.ok, false);
    assert.equal(r.layered, false);
  });

  it('没有 timeseries 时给出可读错误', () => {
    const r = normalizeMetNo({ properties: {} });
    assert.equal(r.ok, false);
    assert.match(r.error, /timeseries/);
  });

  it('时间按 UTC 正确解析', () => {
    const raw = {
      properties: {
        timeseries: [
          {
            time: '2026-10-18T09:00:00Z',
            data: {
              instant: {
                details: {
                  cloud_area_fraction_low: 10,
                  cloud_area_fraction_medium: 20,
                  cloud_area_fraction_high: 30,
                },
              },
            },
          },
        ],
      },
    };
    const r = normalizeMetNo(raw);
    assert.equal(r.series[0].t, Date.UTC(2026, 9, 18, 9, 0, 0));
  });

  it('fetchLayers 会带上 User-Agent（MET Norway 的硬性要求）', async () => {
    let seen = null;
    const fetchImpl = async (_url, init) => {
      seen = init?.headers?.['user-agent'];
      return new Response(JSON.stringify(makeMetNoForecast({ days: 3 })), { status: 200 });
    };

    const response = await fetchLayers({
      lat: 39.9,
      lon: 116.4,
      fetchImpl,
      userAgent: 'GlowIndex/1.2.3 (+https://github.com/saltcoffee/GlowIndex)',
    });

    assert.equal(seen, 'GlowIndex/1.2.3 (+https://github.com/saltcoffee/GlowIndex)');
    assert.equal(response.kind, 'data');
    assert.equal(response.result.ok, true);
  });

  it('条件请求原样发送验证器，并接受 304', async () => {
    let seen = null;
    const nowMs = Date.UTC(2026, 9, 21, 0, 0, 0);
    const fetchImpl = async (_url, init) => {
      seen = init?.headers;
      return new Response(null, {
        status: 304,
        headers: {
          date: new Date(nowMs).toUTCString(),
          expires: new Date(nowMs + 30 * 60000).toUTCString(),
          'last-modified': 'Tue, 20 Oct 2026 23:00:00 GMT',
          etag: '"forecast-v2"',
        },
      });
    };

    const response = await fetchLayers({
      lat: 39.9,
      lon: 116.4,
      fetchImpl,
      nowMs,
      validators: {
        lastModified: 'Tue, 20 Oct 2026 22:00:00 GMT',
        etag: '"forecast-v1"',
      },
    });

    assert.equal(seen['if-modified-since'], 'Tue, 20 Oct 2026 22:00:00 GMT');
    assert.equal(seen['if-none-match'], '"forecast-v1"');
    assert.equal(response.kind, 'not-modified');
    assert.equal(response.freshUntil, nowMs + 30 * 60000);
    assert.equal(response.lastModified, 'Tue, 20 Oct 2026 23:00:00 GMT');
    assert.equal(response.etag, '"forecast-v2"');
  });

  it('新的 200 响应不沿用旧实体的验证器', async () => {
    const response = await fetchLayers({
      lat: 39.9,
      lon: 116.4,
      validators: { lastModified: 'Tue, 20 Oct 2026 22:00:00 GMT', etag: '"old"' },
      fetchImpl: async () => new Response(JSON.stringify(makeMetNoForecast({ days: 1 }))),
    });

    assert.equal(response.kind, 'data');
    assert.equal(response.lastModified, null);
    assert.equal(response.etag, null);
  });

  it('有效但已到期的 Expires 不会被一小时兜底覆盖', async () => {
    const nowMs = Date.UTC(2026, 9, 21, 0, 0, 0);
    const response = await fetchLayers({
      lat: 39.9,
      lon: 116.4,
      nowMs,
      fetchImpl: async () => new Response(JSON.stringify(makeMetNoForecast({ days: 1 })), {
        headers: {
          date: new Date(nowMs).toUTCString(),
          expires: new Date(nowMs - 60000).toUTCString(),
        },
      }),
    });

    assert.equal(response.freshUntil, nowMs);
  });
});
