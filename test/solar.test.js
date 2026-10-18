import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { julianDay, sunElevationAzimuth, sunPositionJD, sunTimes } from '../src/lib/solar.js';
import { formatClock } from '../src/lib/time.js';

const BJ = { lat: 39.9042, lon: 116.4074, tz: 'Asia/Shanghai' };

/** "HH:MM" → 当天分钟数 */
const minutes = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

describe('太阳位置：日出日落', () => {
  it('北京夏至与天文年历一致（04:45 / 19:46）', () => {
    const st = sunTimes(BJ.lat, BJ.lon, '2026-06-21', { tz: BJ.tz });
    assert.equal(st.kind, 'normal');
    assert.equal(formatClock(BJ.tz, st.sunriseMs), '04:45');
    assert.equal(formatClock(BJ.tz, st.sunsetMs), '19:46');
    assert.ok(Math.abs(st.dayLengthMin / 60 - 15.0) < 0.05, `白昼长度 ${st.dayLengthMin / 60}h`);
  });

  it('北京冬至与天文年历一致（07:32 / 16:52）', () => {
    const st = sunTimes(BJ.lat, BJ.lon, '2026-12-21', { tz: BJ.tz });
    assert.equal(formatClock(BJ.tz, st.sunriseMs), '07:32');
    assert.equal(formatClock(BJ.tz, st.sunsetMs), '16:52');
  });

  it('赤道春分：日出日落相对正午对称，白昼略长于 12h（含蒙气差）', () => {
    const st = sunTimes(0, 0, '2026-03-20', { tz: 'UTC' });
    const rise = minutes(formatClock('UTC', st.sunriseMs));
    const set = minutes(formatClock('UTC', st.sunsetMs));
    const noon = minutes(formatClock('UTC', st.solarNoonMs));
    assert.ok(Math.abs((rise + set) / 2 - noon) <= 1.5, '日出日落应以正午对称');
    assert.ok(st.dayLengthMin > 12 * 60 && st.dayLengthMin < 12 * 60 + 12);
  });

  it('极昼返回 polar-day 而不是瞎算一个时刻', () => {
    const st = sunTimes(78, 15, '2026-06-21', { tz: 'UTC' });
    assert.equal(st.kind, 'polar-day');
    assert.equal(st.sunriseMs, null);
  });

  it('返回的时刻落在此地当天的本地日期上（东八区不会跑到前一天）', () => {
    const st = sunTimes(BJ.lat, BJ.lon, '2026-10-18', { tz: BJ.tz });
    for (const ms of [st.sunriseMs, st.sunsetMs]) {
      const local = new Date(ms + 8 * 3600000).toISOString().slice(0, 10);
      assert.equal(local, '2026-10-18');
    }
  });
});

describe('太阳位置：高度角与方位角', () => {
  it('正午高度角符合 90 - |纬度 - 赤纬|', () => {
    const st = sunTimes(BJ.lat, BJ.lon, '2026-06-21', { tz: BJ.tz });
    const { elevation } = sunElevationAzimuth(BJ.lat, BJ.lon, st.solarNoonMs);
    const expected = 90 - Math.abs(BJ.lat - st.declination);
    assert.ok(
      Math.abs(elevation - expected) < 0.2,
      `实测 ${elevation.toFixed(3)}°，期望 ${expected.toFixed(3)}°`,
    );
  });

  it('日出日落时刻的高度角接近 -0.833°', () => {
    const st = sunTimes(BJ.lat, BJ.lon, '2026-10-18', { tz: BJ.tz });
    const e1 = sunElevationAzimuth(BJ.lat, BJ.lon, st.sunriseMs).elevation;
    const e2 = sunElevationAzimuth(BJ.lat, BJ.lon, st.sunsetMs).elevation;
    assert.ok(Math.abs(e1 + 0.833) < 0.15, `日出高度角 ${e1}`);
    assert.ok(Math.abs(e2 + 0.833) < 0.15, `日落高度角 ${e2}`);
  });

  it('北京冬至落日方位约 239°（西南偏南）', () => {
    const st = sunTimes(BJ.lat, BJ.lon, '2026-12-21', { tz: BJ.tz });
    const { azimuth } = sunElevationAzimuth(BJ.lat, BJ.lon, st.sunsetMs);
    assert.ok(Math.abs(azimuth - 239.5) < 1.5, `方位角 ${azimuth.toFixed(1)}°`);
  });

  it('均时差在 11 月 3 日约为 +16.4 分钟', () => {
    const { eqTime } = sunPositionJD(julianDay(2026, 11, 3, 12));
    assert.ok(Math.abs(eqTime - 16.4) < 0.3, `eqTime ${eqTime.toFixed(2)} 分钟`);
  });
});
