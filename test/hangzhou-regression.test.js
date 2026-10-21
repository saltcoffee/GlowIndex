import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import worker from '../src/index.js';
import { clearMemoryCache } from '../src/lib/cache.js';
import { makeWeatherApiForecast } from '../tools/mock-data.js';

const TZ = 'Asia/Shanghai';
const START = '2026-10-18';
const NOW = Date.parse('2026-10-18T11:50:15Z');
const LAT = 30.2741;
const LON = 120.1551;
const FIRST_LAYER_TIME = Date.parse('2026-10-18T11:00:00Z');
const MS_HOUR = 3600000;

function weatherForecast(days) {
  const raw = makeWeatherApiForecast({
    lat: LAT,
    lon: LON,
    tz: TZ,
    name: 'Hangzhou',
    region: 'Zhejiang',
    days,
    startDate: START,
  });
  for (const day of raw.forecast.forecastday) {
    day.astro.sunset = '05:25 PM';
    for (const hour of day.hour) {
      Object.assign(hour, {
        cloud: 98,
        humidity: 81.4,
        temp_c: 23.4,
        dewpoint_c: 20.1,
        vis_km: 10,
        precip_mm: 0.32,
        chance_of_rain: 46,
        wind_kph: 18,
        gust_kph: 29,
        condition: { text: '小阵雨', code: 1240 },
      });
    }
  }
  return raw;
}

function layeredForecast(firstTime = FIRST_LAYER_TIME) {
  // 线上故障的 MET 数据从 19:00 才开始；17:25 日落窗口不在覆盖范围内。
  // 修复前这一条夜间云层被复制到白天，导致日落得到 94.2 分、置信度 0.94。
  const timeseries = Array.from({ length: 29 }, (_, i) => ({
    time: new Date(firstTime + i * MS_HOUR).toISOString(),
    data: {
      instant: {
        details: {
          cloud_area_fraction: 68.7,
          cloud_area_fraction_low: 4.7,
          cloud_area_fraction_medium: 13.3,
          cloud_area_fraction_high: 62.5,
          air_temperature: 23.4,
          dew_point_temperature: 20.1,
          relative_humidity: 81.4,
        },
      },
    },
  }));
  return { properties: { timeseries } };
}

function makeEnv(days, firstLayerTime = FIRST_LAYER_TIME) {
  return {
    WEATHERAPI_KEY: 'hangzhou-regression-key',
    fetchImpl: async (url) => {
      const hostname = new URL(url).hostname;
      let raw;
      if (hostname === 'api.weatherapi.com') raw = weatherForecast(days);
      else if (hostname === 'api.met.no') raw = layeredForecast(firstLayerTime);
      else throw new Error(`测试未覆盖的上游：${hostname}`);
      return new Response(JSON.stringify(raw), {
        headers: { 'content-type': 'application/json' },
      });
    },
  };
}

async function query({ days = 1, detail = 'standard', env = makeEnv(days) } = {}) {
  const url = new URL('https://hangzhou-regression.test/v1/glow');
  for (const [key, value] of Object.entries({ lat: LAT, lon: LON, days, event: 'sunset', detail })) {
    url.searchParams.set(key, String(value));
  }
  const response = await worker.fetch(new Request(url), env, {});
  assert.equal(response.status, 200);
  return response.json();
}

beforeEach((t) => {
  clearMemoryCache();
  t.mock.method(Date, 'now', () => NOW);
});

describe('杭州 2026-10-18：日落早于 MET 分层云覆盖范围', () => {
  it('不把 19:00 夜间云层当成 17:25 日落的真实分层云', async () => {
    const body = await query();
    const [event] = body.events;

    assert.equal(event.id, '2026-10-18-sunset');
    assert.equal(event.eventTime, '17:25');
    assert.equal(event.weather.layered, false, '整个日落窗口都没有真实分层云');
    assert.notEqual(event.level.code, 'epic', `旧版误报为 ${event.score} 分世纪大烧`);
    assert.ok(event.confidence < 0.94, '推断云层的置信度必须低于真实分层云');
    assert.ok(event.notes.some((note) => note.includes('分层云') && note.includes('推断')));
    assert.ok(body.limitations.some((note) => note.includes('分层云') && note.includes('推断')));
    assert.ok(event.timeline.length > 0);
    for (const point of event.timeline) {
      assert.equal(point.cloudHigh, 5, `${point.time} 不得出现从 19:00 复制的 63% 高云`);
    }
    assert.equal(body.score, event.score);
    assert.equal(body.confidence, event.confidence);
    assert.notEqual(body.level.code, 'epic');
  });

  it('brief 响应仍明确区分推断云层并保留限制说明', async () => {
    const body = await query({ detail: 'brief' });
    const [event] = body.events;

    assert.equal(event.weather.layered, false);
    assert.equal(event.weather.cloudHigh, 5);
    assert.notEqual(event.level.code, 'epic');
    assert.ok(event.confidence < 0.94);
    assert.ok(event.notes.some((note) => note.includes('分层云') && note.includes('推断')));
    assert.ok(body.limitations.some((note) => note.includes('分层云') && note.includes('推断')));
    assert.equal(body.best.weather.layered, false);
    assert.equal(body.best.confidence, event.confidence);
  });

  it('次日落在 MET 覆盖范围内时继续使用真实分层云', async () => {
    const body = await query({ days: 2 });
    const historical = body.events.find((event) => event.date === START);
    const future = body.events.find((event) => event.date === '2026-10-19');

    assert.equal(historical.weather.layered, false);
    assert.equal(future.weather.layered, true);
    assert.equal(future.weather.cloudLow, 5);
    assert.equal(future.weather.cloudMid, 13);
    assert.equal(future.weather.cloudHigh, 63);
    assert.ok(future.confidence > historical.confidence);
    assert.ok(!future.notes.some((note) => note.includes('分层云') && note.includes('推断')));
    assert.equal(body.next.id, future.id);
  });

  it('生产 Cache API 序列化后保持覆盖判断且不提前引入未来云层', async (t) => {
    const previousCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches');
    const cachedResponses = new Map();
    Object.defineProperty(globalThis, 'caches', {
      configurable: true,
      value: {
        default: {
          async match(key) {
            const body = cachedResponses.get(String(key));
            return body == null ? undefined : new Response(body);
          },
          async put(key, response) {
            cachedResponses.set(String(key), await response.text());
          },
        },
      },
    });
    t.after(() => {
      if (previousCaches) Object.defineProperty(globalThis, 'caches', previousCaches);
      else Reflect.deleteProperty(globalThis, 'caches');
    });

    const env = makeEnv(1, Date.parse('2026-10-18T09:30:00Z'));
    const cold = await query({ env });
    const cached = await query({ env });

    assert.equal(cold.dataSources[0].cached, false);
    assert.equal(cached.dataSources[0].cached, true);
    assert.deepEqual(cached.events, cold.events, 'JSON 缓存命中不得丢失真实源的时间边界');
    const beforeCoverage = cold.events[0].timeline.filter((point) => point.time < '17:30');
    assert.ok(beforeCoverage.length > 0);
    assert.ok(beforeCoverage.every((point) => point.cloudHigh === 5));
  });
});
