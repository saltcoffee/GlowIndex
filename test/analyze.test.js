import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeMetNo } from '../src/adapters/metno.js';
import { normalizeForecast } from '../src/adapters/weatherapi.js';
import { analyzeEvents, compassName, pickBestEvent, toPublicEvent } from '../src/core/analyze.js';
import { buildSeries, inferLayers, sampleSeries } from '../src/core/series.js';
import {
  makeMetNoForecast,
  makeWeatherApiForecast,
} from '../tools/mock-data.js';

const TZ = 'Asia/Shanghai';
const LAT = 39.9042;
const LON = 116.4074;
const START = '2026-10-18';

function buildFixture({ scenarios, days = 3 } = {}) {
  const wa = normalizeForecast(
    makeWeatherApiForecast({ tz: TZ, days, startDate: START, scenarios }),
  );
  const om = normalizeMetNo(makeMetNoForecast({ tz: TZ, days, startDate: START, scenarios }));
  const hours = wa.days.flatMap((d) => d.hours);
  const series = buildSeries({ hours, om: om.series, aq: null });
  return { wa, om, hours, series };
}

describe('序列层', () => {
  it('缺分层数据时用总云量推断，规则可解释', () => {
    const wet = inferLayers({ cloudTotal: 100, rh: 92, visKm: 5, precipMm: 1 });
    assert.ok(wet.low > wet.mid && wet.mid > wet.high, '湿气重应推断为低云');

    const dry = inferLayers({ cloudTotal: 60, rh: 40, visKm: 20, precipMm: 0 });
    assert.ok(dry.high + dry.mid > dry.low, '干爽应推断为中高云');

    for (const r of [wet, dry]) {
      const sum = r.low + r.mid + r.high;
      assert.ok(sum <= 100.001 && sum >= 0);
    }
  });

  it('线性插值在两端取端点值，中间取加权', () => {
    const series = [
      { t: 0, cloudLow: 0, layered: true },
      { t: 1000, cloudLow: 100, layered: true },
    ];
    assert.equal(sampleSeries(series, -500).cloudLow, 0);
    assert.equal(sampleSeries(series, 5000).cloudLow, 100);
    const mid = sampleSeries(series, 250);
    assert.ok(Math.abs(mid.cloudLow - 25) < 1e-9);
  });

  it('合并序列保留 WeatherAPI 的时间骨架且带上分层云', () => {
    const { hours, series } = buildFixture();
    assert.equal(series.length, hours.length);
    assert.ok(series.some((r) => r.layered === true));
    assert.ok(series.every((r) => r.cloudLow != null && r.cloudMid != null));
    for (let i = 1; i < series.length; i += 1) {
      assert.ok(series[i].t >= series[i - 1].t, '序列必须按时间升序');
    }
  });
});

describe('事件编排', () => {
  it('每天产出日出 + 日落两条事件', () => {
    const { wa, series } = buildFixture();
    const events = analyzeEvents({
      lat: LAT,
      lon: LON,
      tz: TZ,
      series,
      days: wa.days.map((d) => ({ date: d.date, astro: d.astro })),
      layered: true,
    });
    assert.equal(events.length, 6);
    assert.deepEqual(
      events.map((e) => e.type),
      ['sunrise', 'sunset', 'sunrise', 'sunset', 'sunrise', 'sunset'],
    );
  });

  it('采样点全部落在太阳高度角窗口内，峰值也在窗口内', () => {
    const { wa, series } = buildFixture();
    const events = analyzeEvents({
      lat: LAT,
      lon: LON,
      tz: TZ,
      series,
      days: wa.days.map((d) => ({ date: d.date, astro: d.astro })),
      layered: true,
    });
    for (const e of events) {
      assert.ok(e.peakOffsetMin >= -60 && e.peakOffsetMin <= 60);
      for (const p of e.timeline) {
        assert.ok(p.elevation >= -8.001 && p.elevation <= 10.001, `高度角越界 ${p.elevation}`);
        assert.ok(p.score >= 0 && p.score <= 100);
      }
    }
  });

  it('事件时刻优先采用上游 astro，并与天文计算基本一致', () => {
    const { wa, series } = buildFixture();
    const events = analyzeEvents({
      lat: LAT,
      lon: LON,
      tz: TZ,
      series,
      days: wa.days.map((d) => ({ date: d.date, astro: d.astro })),
      layered: true,
    });
    const sunset = events.find((e) => e.type === 'sunset');
    assert.equal(sunset.eventTime, '17:31');
    // 合成数据本身就是用同一套天文算法生成的，所以偏差应该是 0 分钟
    assert.ok(!sunset.notes.some((n) => n.includes('相差')));
  });

  it('降水日必然落在低档位', () => {
    const { wa, series } = buildFixture({ scenarios: ['rainy', 'rainy', 'rainy'] });
    const events = analyzeEvents({
      lat: LAT,
      lon: LON,
      tz: TZ,
      series,
      days: wa.days.map((d) => ({ date: d.date, astro: d.astro })),
      layered: true,
    });
    for (const e of events) assert.ok(e.score < 28, `${e.id} 得分 ${e.score}`);
  });

  it('优秀条件日能到大烧以上，且建议里包含出门提醒', () => {
    const { wa, series } = buildFixture({ scenarios: ['big', 'big', 'big'] });
    const events = analyzeEvents({
      lat: LAT,
      lon: LON,
      tz: TZ,
      series,
      days: wa.days.map((d) => ({ date: d.date, astro: d.astro })),
      layered: true,
    });
    const sunset = events.find((e) => e.id === '2026-10-18-sunset');
    assert.ok(sunset.score >= 74, `得分 ${sunset.score}`);
    assert.ok(sunset.advice.some((a) => a.includes('提前')));
  });

  it('事件对象带 6 个因子与置信度说明', () => {
    const { wa, series } = buildFixture();
    const [ev] = analyzeEvents({
      lat: LAT,
      lon: LON,
      tz: TZ,
      series,
      days: wa.days.map((d) => ({ date: d.date, astro: d.astro })),
      layered: true,
    });
    assert.equal(ev.factors.length, 6);
    assert.ok(ev.confidence > 0.5 && ev.confidence <= 0.98);
    assert.ok(ev.sun.whereToLook.includes('方位角'));
    assert.ok(ev.timeline.length > 0);
  });

  it('缺分层云时置信度下降并写进 notes', () => {
    const wa = normalizeForecast(
      makeWeatherApiForecast({ tz: TZ, days: 1, startDate: START, scenarios: ['big'] }),
    );
    const hours = wa.days.flatMap((d) => d.hours);
    const series = buildSeries({ hours, om: null, aq: null });
    assert.ok(series.every((r) => r.layered === false));

    const [ev] = analyzeEvents({
      lat: LAT,
      lon: LON,
      tz: TZ,
      series,
      days: wa.days.map((d) => ({ date: d.date, astro: d.astro })),
      layered: false,
    });
    assert.ok(ev.confidence < 0.9);
    assert.ok(ev.notes.some((n) => n.includes('分层云量')));
    assert.ok(ev.weather.layered === false);
  });

  it('pickBestEvent 优先未结束的事件', () => {
    const mk = (id, score, ms) => ({ id, score, __ms: ms });
    const now = Date.UTC(2026, 9, 18, 9, 0, 0);
    const past = mk('past', 99, now - 3 * 3600000);
    const soon = mk('soon', 50, now + 2 * 3600000);
    assert.equal(pickBestEvent([past, soon], now).id, 'soon');
    assert.equal(pickBestEvent([past, soon], now + 24 * 3600000).id, 'past');
  });

  it('toPublicEvent 去掉内部字段', () => {
    const pub = toPublicEvent({ id: 'x', score: 1, __ms: 123 });
    assert.equal(pub.__ms, undefined);
    assert.equal(pub.id, 'x');
  });

  it('方位角转中文', () => {
    assert.equal(compassName(0), '北');
    assert.equal(compassName(90), '东');
    assert.equal(compassName(180), '南');
    assert.equal(compassName(270), '西');
    assert.equal(compassName(258), '西偏南');
  });
});
