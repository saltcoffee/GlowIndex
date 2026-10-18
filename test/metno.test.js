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

    const r = await fetchLayers({
      lat: 39.9,
      lon: 116.4,
      days: 2,
      fetchImpl,
      userAgent: 'huoshaoyun-api/1.2 (+https://sunset.redpencil.top)',
    });

    assert.equal(seen, 'huoshaoyun-api/1.2 (+https://sunset.redpencil.top)');
    assert.equal(r.ok, true);
    // 只保留需要的天数（days=2 → 最多到 now+3 天）
    const limit = Date.now() + 3 * 86400000;
    assert.ok(r.series.every((row) => row.t <= limit));
  });
});
