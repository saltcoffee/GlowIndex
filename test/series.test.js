import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildSeries, cloudSpread, inferLayers, sampleSeries } from '../src/core/series.js';

const HOUR = 3600000;
const at = (hour) => Date.UTC(2026, 9, 17, 16) + hour * HOUR;
const hour = (time, extra = {}) => ({
  t: at(time), cloudTotal: 90, rh: 92, tempC: 20, dewC: 19,
  visKm: 20, precipMm: 0, ...extra,
});
const layers = (time, extra = {}) => ({
  t: at(time), cloudLow: 4.7, cloudMid: 13.3, cloudHigh: 62.5,
  rh: 40, tempC: 28, dewC: 10, ...extra,
});
const cloudLayers = ({ cloudLow, cloudMid, cloudHigh }) => ({
  low: cloudLow, mid: cloudMid, high: cloudHigh,
});

// 所有覆盖回归同时模拟 Cloudflare Cache API 的 JSON 往返。
function freshAndCached(series) {
  return [series, JSON.parse(JSON.stringify(series))];
}

describe('天气序列覆盖边界', () => {
  it('只在真实时间范围内插值，单点只覆盖自身时刻', () => {
    const rows = [{ t: 0, cloudTotal: 10 }, { t: HOUR, cloudTotal: 90 }];
    assert.equal(sampleSeries(rows, -1), null);
    assert.equal(sampleSeries(rows, HOUR + 1), null);
    assert.equal(sampleSeries(rows, HOUR / 4).cloudTotal, 30);
    assert.equal(sampleSeries(rows, 0).cloudTotal, 10);
    assert.equal(sampleSeries(rows, HOUR).cloudTotal, 90);
    assert.equal(sampleSeries([rows[0]], -1), null);
    assert.equal(sampleSeries([rows[0]], 1), null);
    assert.deepEqual(sampleSeries([rows[0]], 0), rows[0]);
    assert.equal(sampleSeries([], 0), null);
    assert.equal(sampleSeries(rows, Number.NaN), null);
  });

  it('某字段单侧缺失时不把另一端值当成整个区间的观测', () => {
    const rows = [layers(19), layers(20, { cloudHigh: null, rh: null })];
    const sample = sampleSeries(rows, at(19.5));
    assert.equal(sample.cloudHigh, null);
    assert.equal(sample.rh, null);
    assert.equal(sampleSeries(rows, at(19)).cloudHigh, 62.5);
    assert.equal(sampleSeries(rows, at(20)).cloudHigh, null);
  });

  it('杭州17:25日落不能使用首条19:00的有利分层云', () => {
    const hours = [16, 17, 18, 19, 20, 21].map((time) => hour(time));
    const series = buildSeries({ hours, om: [layers(19), layers(20)], aq: null });
    assert.equal(series.length, hours.length, '保留逐小时骨架，避免重复累计降水');
    for (const rows of freshAndCached(series)) {
      const sunset = sampleSeries(rows, at(17 + 25 / 60));
      assert.equal(sunset.layered, false);
      assert.deepEqual(cloudLayers(sunset), inferLayers(sunset));
      assert.equal(sunset.rh, 92);
      assert.equal(sunset.tempC, 20);
      assert.equal(sunset.dewC, 19);
      assert.equal(rows.find((row) => row.t === at(19)).layered, true);
      assert.equal(rows.find((row) => row.t === at(21)).layered, false);
    }
  });

  it('19:30才开始的分层源在混合小时边界保守降级，不提前借用20点温湿', () => {
    const series = buildSeries({
      hours: [19, 20, 21, 22].map((time) => hour(time)),
      om: [layers(19.5), layers(20.5), layers(21)], aq: null,
    });
    for (const rows of freshAndCached(series)) {
      for (const time of [19.25, 19.75, 21.25, 21.75]) {
        const sample = sampleSeries(rows, at(time));
        assert.equal(sample.layered, false, `${time}应使用推断云量`);
        assert.equal(sample.rh, 92, `${time}不应混入MET的干燥空气`);
        assert.equal(sample.tempC, 20);
        assert.equal(sample.dewC, 19);
        assert.deepEqual(cloudLayers(sample), { low: 72, mid: 13.5, high: 4.5 });
      }
      const covered = sampleSeries(rows, at(20.5));
      assert.equal(covered.layered, true);
      assert.equal(covered.rh, 40);
      assert.equal(covered.tempC, 28);
      assert.equal(covered.dewC, 10);
      assert.deepEqual(cloudLayers(covered), { low: 4.7, mid: 13.3, high: 62.5 });
      assert.equal('layerWeather' in covered, false, '采样结果不携带内部源数据');
    }
  });

  it('仅一个非整点分层观测不能扩展成整小时覆盖', () => {
    const series = buildSeries({
      hours: [19, 20, 21].map((time) => hour(time)),
      om: [layers(19.5)], aq: null,
    });
    for (const rows of freshAndCached(series)) {
      assert.ok(rows.every((row) => row.layered === false));
      assert.equal(sampleSeries(rows, at(19.5)).layered, false);
    }
    const exact = buildSeries({
      hours: [19, 20, 21].map((time) => hour(time)), om: [layers(20)], aq: null,
    });
    assert.equal(sampleSeries(exact, at(20)).layered, true);
    assert.equal(sampleSeries(exact, at(19.99)).layered, false);
    assert.equal(sampleSeries(exact, at(20.01)).layered, false);
  });

  it('不完整的分层云点打断真实覆盖，其间重新推断', () => {
    const series = buildSeries({
      hours: [19, 20, 21, 22, 23].map((time) => hour(time)),
      om: [layers(19), layers(21, { cloudMid: null }), layers(23)], aq: null,
    });
    for (const rows of freshAndCached(series)) {
      assert.deepEqual(rows.map((row) => row.layered), [true, false, false, false, true]);
      for (const time of [19.75, 20.5, 22.25]) {
        const sample = sampleSeries(rows, at(time));
        assert.equal(sample.layered, false);
        assert.equal(sample.rh, 92);
        assert.deepEqual(cloudLayers(sample), inferLayers(sample));
      }
    }
  });

  it('真实分层覆盖中按同源温湿插值，缺失的MET温湿回退到基础源', () => {
    const series = buildSeries({
      hours: [19, 20].map((time) => hour(time)),
      om: [layers(19), layers(20, { rh: 60, tempC: 24, dewC: null })], aq: null,
    });
    for (const rows of freshAndCached(series)) {
      const exact = sampleSeries(rows, at(19));
      assert.equal(exact.rh, 40);
      assert.equal(exact.tempC, 28);
      const sample = sampleSeries(rows, at(19.5));
      assert.equal(sample.layered, true);
      assert.equal(sample.rh, 50);
      assert.equal(sample.tempC, 26);
      assert.equal(sample.dewC, 19, '不能在MET露点缺失时与WA露点混插');
    }
  });

  it('AOD源同样禁止在覆盖范围外外推', () => {
    const series = buildSeries({
      hours: [18, 19, 20, 21].map((time) => hour(time)), om: null,
      aq: [{ t: at(19), aod: 0.1 }, { t: at(20), aod: 0.3 }],
    });
    for (const rows of freshAndCached(series)) {
      assert.equal(sampleSeries(rows, at(18.75)).aod, null);
      assert.equal(sampleSeries(rows, at(19.5)).aod, 0.2);
      assert.equal(sampleSeries(rows, at(20.25)).aod, null);
    }
  });
});

describe('事件窗口云量波动', () => {
  it('55分钟且没有整点时仍计算窗口两端的云量差异', () => {
    const rows = [{ t: 0, cloudTotal: 0 }, { t: HOUR, cloudTotal: 60 }];
    assert.equal(cloudSpread(rows, 2 * 60000, 57 * 60000), 27.5);
  });

  it('55分钟且只有一个整点时保留两端与整点的真实变化', () => {
    const rows = [0, 1, 2].map((time) => ({ t: time * HOUR, cloudTotal: time * 60 }));
    const actual = cloudSpread(rows, 50 * 60000, 105 * 60000);
    const expected = Math.sqrt(((50 - 215 / 3) ** 2 + (60 - 215 / 3) ** 2
      + (105 - 215 / 3) ** 2) / 3);
    assert.ok(Math.abs(actual - expected) < 1e-9);
  });

  it('仅使用被序列覆盖的窗口，边界整点不重复计入', () => {
    const rows = [{ t: 0, cloudTotal: 0 }, { t: HOUR, cloudTotal: 60 }];
    assert.equal(cloudSpread(rows, -HOUR, HOUR * 2), 30);
    assert.equal(cloudSpread(rows, HOUR * 2, HOUR * 3), 0);
    assert.equal(cloudSpread(rows, HOUR / 2, HOUR / 2), 0);
    assert.equal(cloudSpread(rows, 0, HOUR), 30);
  });
});
