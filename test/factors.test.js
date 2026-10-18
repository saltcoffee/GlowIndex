import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { WEIGHTS } from '../src/config.js';
import {
  canvasGate,
  evaluateSample,
  scoreCanvas,
  scoreClarity,
  scoreLowCloud,
} from '../src/core/factors.js';
import { levelFor } from '../src/core/levels.js';

/** 一个"其余条件都很好"的基准天气 */
const base = {
  cloudTotal: 55,
  cloudLow: 12,
  cloudMid: 35,
  cloudHigh: 55,
  rh: 48,
  tempC: 22,
  dewC: 8,
  visKm: 22,
  windKph: 12,
  gustKph: 20,
  precipMm: 0,
  chanceRain: 0,
  aod: 0.15,
  layered: true,
};

const scoreOf = (weather, elevation = -0.8, extra = {}) =>
  evaluateSample({ elevation, weather: { ...base, ...weather }, ...extra }).score;

describe('评分模型：量级合理性', () => {
  it('权重之和为 1', () => {
    const sum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9);
  });

  it('晴朗无云几乎不可能烧起来', () => {
    const s = scoreOf({ cloudLow: 0, cloudMid: 0, cloudHigh: 0, cloudTotal: 0 });
    assert.ok(s < 28, `实际得分 ${s}`);
    assert.equal(levelFor(s).name, '不烧');
  });

  it('教科书级条件能到大烧或以上', () => {
    const s = scoreOf({});
    assert.ok(s >= 74, `实际得分 ${s}`);
  });

  it('低云封天 + 下雨必然是"不烧"', () => {
    const s = scoreOf({
      cloudLow: 90,
      cloudMid: 10,
      cloudHigh: 20,
      rh: 92,
      tempC: 14,
      dewC: 12,
      visKm: 6,
      precipMm: 3,
      chanceRain: 90,
    });
    assert.ok(s < 28, `实际得分 ${s}`);
  });

  it('分数始终落在 0–100 且不含 NaN', () => {
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let i = 0; i < 300; i += 1) {
      const w = {
        cloudTotal: rand() * 100,
        cloudLow: rand() * 100,
        cloudMid: rand() * 100,
        cloudHigh: rand() * 100,
        rh: rand() * 100,
        tempC: rand() * 40 - 5,
        dewC: rand() * 30 - 10,
        visKm: rand() * 30,
        windKph: rand() * 80,
        gustKph: rand() * 120,
        precipMm: rand() * 12,
        chanceRain: rand() * 100,
        aod: rand() * 2,
        layered: rand() > 0.5,
      };
      const s = scoreOf(w, rand() * 20 - 10);
      assert.ok(Number.isFinite(s), 'NaN 出现');
      assert.ok(s >= 0 && s <= 100, `越界 ${s}`);
    }
  });

  it('字段全缺失时给中性分，不会崩', () => {
    const r = evaluateSample({ elevation: -0.8, weather: {} });
    assert.ok(Number.isFinite(r.score));
    assert.ok(r.score > 0 && r.score < 60);
  });
});

describe('评分模型：单调性与形状', () => {
  it('低云越多分越低', () => {
    const a = scoreOf({ cloudLow: 0 });
    const b = scoreOf({ cloudLow: 30 });
    const c = scoreOf({ cloudLow: 60 });
    assert.ok(a > b, `${a} > ${b}`);
    assert.ok(b > c, `${b} > ${c}`);
  });

  it('云量太少会被"可烧云量"闸门压住', () => {
    const none = scoreOf({ cloudLow: 2, cloudMid: 2, cloudHigh: 2, cloudTotal: 3 });
    const enough = scoreOf({});
    assert.ok(none < enough - 25, `${none} 应显著低于 ${enough}`);
  });

  it('高云越满越好，中云铺满反而变差', () => {
    assert.ok(scoreCanvas(0, 90).score > scoreCanvas(0, 30).score);
    assert.ok(scoreCanvas(50, 0).score > scoreCanvas(100, 0).score);
  });

  it('能见度与湿度都会单调影响通透度', () => {
    const good = scoreClarity({ visKm: 20, tempC: 20, dewC: 6, rh: 50, aod: 0.15 }).score;
    const hazy = scoreClarity({ visKm: 4, tempC: 20, dewC: 6, rh: 50, aod: 0.15 }).score;
    const muggy = scoreClarity({ visKm: 20, tempC: 20, dewC: 19, rh: 96, aod: 0.15 }).score;
    assert.ok(good > hazy);
    assert.ok(good > muggy);
  });

  it('可烧云量闸门在 0 附近接近 0.15，在 48 以上为 1', () => {
    assert.ok(Math.abs(canvasGate(0) - 0.15) < 1e-9);
    assert.equal(canvasGate(48), 1);
    assert.equal(canvasGate(100), 1);
  });

  it('低云因子在 0 时为满分，70 以上为 0 分', () => {
    assert.equal(scoreLowCloud(0).score, 1);
    assert.equal(scoreLowCloud(70).score, 0);
  });
});

describe('档位划分', () => {
  it('边界值落到正确的档', () => {
    assert.equal(levelFor(0).name, '不烧');
    assert.equal(levelFor(27.9).name, '不烧');
    assert.equal(levelFor(28).name, '微烧');
    assert.equal(levelFor(44).name, '小烧');
    assert.equal(levelFor(58).name, '中烧');
    assert.equal(levelFor(74).name, '大烧');
    assert.equal(levelFor(90).name, '世纪大烧');
    assert.equal(levelFor(100).name, '世纪大烧');
  });
});
