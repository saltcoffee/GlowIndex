import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { LEVELS } from '../src/config.js';
import worker from '../src/index.js';
import { clearMemoryCache } from '../src/lib/cache.js';
import { createMockFetch, todayIn } from '../tools/mock-data.js';

const TZ = 'Asia/Shanghai';
const TODAY = todayIn(TZ);

function makeEnv(overrides = {}) {
  return { WEATHERAPI_KEY: 'test-key', fetchImpl: createMockFetch(), ...overrides };
}

async function call(path, env = makeEnv(), init = {}) {
  const res = await worker.fetch(new Request(`https://api.example.test${path}`, init), env, {});
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: res.status, headers: res.headers, body };
}

beforeEach(() => clearMemoryCache());

describe('GET /v1/glow 正常路径', () => {
  it('只传地址就能拿到结论', async () => {
    const { status, body } = await call('/v1/glow?address=北京');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.location.name, 'Beijing');
    assert.equal(body.location.timezone, TZ);
    assert.ok(body.events.length >= 2);
    assert.ok(typeof body.score === 'number');
    assert.ok(body.level && typeof body.level.name === 'string');
  });

  it('顶层直接给出档位，且档位名在六档之内', async () => {
    const { body } = await call('/v1/glow?address=北京');
    const names = LEVELS.map((l) => l.name);
    assert.ok(names.includes(body.level.name), body.level.name);
    assert.ok(body.score >= 0 && body.score <= 100);
  });

  it('事件里有 6 个因子、权重和为 1、明细完整', async () => {
    const { body } = await call('/v1/glow?address=北京&days=1');
    const ev = body.events.find((e) => e.type === 'sunset');
    assert.ok(ev, '应有晚霞事件');
    assert.equal(ev.factors.length, 6);
    const sum = ev.factors.reduce((a, f) => a + f.weight, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9);
    for (const f of ev.factors) {
      assert.ok(f.detail.length > 0, `${f.key} 缺少解释`);
      assert.ok(f.contribution >= 0 && f.contribution <= 100);
    }
    assert.ok(ev.weather.cloudLow != null);
    assert.ok(ev.timeline.length > 0);
    assert.ok(ev.advice.length > 0);
  });

  it('带 CORS 头，便于任何前端直接调用', async () => {
    const { headers } = await call('/v1/glow?address=北京');
    assert.equal(headers.get('access-control-allow-origin'), '*');
    assert.equal(headers.get('content-type'), 'application/json; charset=utf-8');
  });

  it('event=sunset 只返回晚霞', async () => {
    const { body } = await call('/v1/glow?address=北京&event=sunset');
    assert.ok(body.events.length > 0);
    assert.ok(body.events.every((e) => e.type === 'sunset'));
  });

  it('支持中文档位别名 event=晚霞', async () => {
    const { body } = await call('/v1/glow?address=北京&event=%E6%99%9A%E9%9C%9E');
    assert.ok(body.events.every((e) => e.type === 'sunset'));
  });

  it('detail=brief 时去掉因子明细，体积明显变小', async () => {
    const full = await call('/v1/glow?address=北京&days=1');
    const brief = await call('/v1/glow?address=北京&days=1&detail=brief');
    assert.equal(brief.body.events[0].factors, undefined);
    assert.ok(JSON.stringify(brief.body).length < JSON.stringify(full.body).length);
    assert.ok(brief.body.events[0].level.name);
  });

  it('days 超过免费额度会被截断并说明原因', async () => {
    const { body } = await call('/v1/glow?address=北京&days=7');
    assert.ok(body.events.length <= 6);
    assert.ok(body.limitations.some((l) => l.includes('3 天')));
  });

  it('lat/lon 直传时跳过地名解析', async () => {
    const { body } = await call('/v1/glow?lat=39.9042&lon=116.4074');
    assert.equal(body.query.address, null);
    assert.equal(body.location.resolvedFrom, 'coords');
  });
});

describe('GET /v1/glow 参数与错误', () => {
  it('缺少查询参数返回 400 + 可操作的提示', async () => {
    const { status, body } = await call('/v1/glow');
    assert.equal(status, 400);
    assert.equal(body.error.code, 'MISSING_QUERY');
    assert.ok(body.error.hint.includes('address'));
  });

  it('只给 lat 不给 lon 会被拒绝', async () => {
    const { status, body } = await call('/v1/glow?lat=39.9');
    assert.equal(status, 400);
    assert.equal(body.error.code, 'INVALID_COORDINATE');
  });

  it('经纬度越界会被拒绝', async () => {
    const { body } = await call('/v1/glow?lat=99&lon=116');
    assert.equal(body.error.code, 'INVALID_COORDINATE');
  });

  it('event 参数非法会被拒绝', async () => {
    const { status, body } = await call('/v1/glow?address=北京&event=noon');
    assert.equal(status, 400);
    assert.equal(body.error.code, 'INVALID_EVENT');
  });

  it('地址解析不到返回 404，并给出改写法建议', async () => {
    const { status, body } = await call('/v1/glow?address=完全不存在的地方xyz');
    assert.equal(status, 404);
    assert.equal(body.error.code, 'LOCATION_NOT_FOUND');
    assert.ok(body.error.hint.includes('城市'));
  });

  it('没配置 API Key 时明确报 500，而不是含糊的 502', async () => {
    const env = { fetchImpl: createMockFetch() };
    const { status, body } = await call('/v1/glow?address=北京', env);
    assert.equal(status, 500);
    assert.equal(body.error.code, 'MISSING_API_KEY');
  });

  it('WeatherAPI 返回 2006 时映射成中文提示', async () => {
    const failing = async () =>
      new Response(JSON.stringify({ error: { code: 2006, message: 'API key is invalid.' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    const { status, body } = await call('/v1/glow?lat=39.9&lon=116.4', makeEnv({ fetchImpl: failing }));
    assert.equal(status, 502);
    assert.equal(body.error.code, 'WEATHERAPI_2006');
    assert.equal(body.error.message, 'API Key 无效');
    assert.ok(body.error.hint.includes('WEATHERAPI_KEY'));
  });

  it('未知路由 404，POST 405，OPTIONS 204', async () => {
    assert.equal((await call('/nope')).status, 404);
    assert.equal((await call('/v1/glow?address=北京', makeEnv(), { method: 'POST' })).status, 405);

    const pre = await worker.fetch(
      new Request('https://api.example.test/v1/glow', { method: 'OPTIONS' }),
      makeEnv(),
      {},
    );
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-methods'), 'GET,OPTIONS');
  });
});

describe('缓存与健康检查', () => {
  it('同一地址第二次请求不再打上游', async () => {
    let calls = 0;
    const inner = createMockFetch();
    const counting = async (url, init) => {
      calls += 1;
      return inner(url, init);
    };
    const env = makeEnv({ fetchImpl: counting });

    const first = await call('/v1/glow?address=北京', env);
    const callsAfterFirst = calls;
    assert.ok(callsAfterFirst >= 3, `首次应至少请求 3 个上游，实际 ${callsAfterFirst}`);
    assert.equal(first.body.dataSources[0].cached, false);

    const second = await call('/v1/glow?address=北京', env);
    assert.equal(calls, callsAfterFirst, '第二次不应再请求上游');
    assert.equal(second.body.dataSources[0].cached, true);
    assert.equal(second.body.score, first.body.score);
  });

  it('/health 不访问上游，只报告配置状态', async () => {
    const ok = await call('/health', makeEnv());
    assert.equal(ok.body.ok, true);
    assert.equal(ok.body.configured, true);

    const noKey = await call('/health', {});
    assert.equal(noKey.body.configured, false);
  });

  it('/v1/geo 能展示地名逐级回退的过程', async () => {
    const { body } = await call('/v1/geo?address=杭州市西湖区');
    assert.equal(body.ok, true);
    assert.ok(body.candidatesTried.length > 1, '应该尝试了多个候选');
    assert.ok(body.resolved, '应该解析成功');
    assert.ok(body.resolved.query.includes('杭州'));
    assert.equal(body.resolved.country, 'China');
  });

  it('/ 返回接口自述', async () => {
    const { body } = await call('/');
    assert.equal(body.ok, true);
    assert.ok(body.endpoints['GET /v1/glow']);
    assert.ok(Array.isArray(body.levels));
  });
});
