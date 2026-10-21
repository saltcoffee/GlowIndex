/**
 * 部署后自检：对着一个线上（或本地）地址把关键路径走一遍。
 *
 *   node scripts/smoke.js https://glowindex.xxx.workers.dev
 *   node scripts/smoke.js                      # 默认打本地 8787
 *
 * 退出码 0 = 全绿，1 = 有问题。适合塞进 CI 或发布后手动跑一遍。
 */

const base = (process.argv[2] ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');

const results = [];

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ ok: true, name, detail });
  } catch (err) {
    results.push({ ok: false, name, detail: err.message });
  }
}

async function getJson(path) {
  const res = await fetch(`${base}${path}`, { headers: { accept: 'application/json' } });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`返回的不是 JSON（前 80 字：${text.slice(0, 80)}）`);
  }
  return { res, body };
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

await check('GET /health 可用', async () => {
  const { res, body } = await getJson('/health');
  assert(res.status === 200, `HTTP ${res.status}`);
  assert(body.ok === true, 'ok 不为 true');
  return `v${body.version}，算法 ${body.algorithm}`;
});

await check('WEATHERAPI_KEY 已配置', async () => {
  const { body } = await getJson('/health');
  assert(body.configured === true, 'configured=false：多半是没设 Secret 或名字拼错');
  return '已配置';
});

await check('GET /v1/glow?address=北京 能出结论', async () => {
  const { res, body } = await getJson('/v1/glow?address=' + encodeURIComponent('北京'));
  if (res.status !== 200) {
    throw new Error(`HTTP ${res.status}：${body?.error?.message ?? '未知错误'}`);
  }
  assert(body.ok === true, 'ok 不为 true');
  assert(typeof body.score === 'number', 'score 不是数字');
  assert(body.level?.name, '缺少 level.name');
  return `${body.level.emoji} ${body.level.name} ${body.score} 分 · ${body.location?.name ?? '?'}`;
});

await check('事件数组结构完整', async () => {
  const { body } = await getJson('/v1/glow?address=' + encodeURIComponent('北京') + '&days=1');
  assert(Array.isArray(body.events) && body.events.length >= 2, '事件少于 2 条');
  for (const e of body.events) {
    assert(typeof e.eventTime === 'string', `${e.id} 缺少 eventTime`);
    assert(Array.isArray(e.factors) && e.factors.length === 6, `${e.id} 因子不是 6 项`);
    assert(typeof e.confidence === 'number', `${e.id} 缺少 confidence`);
  }
  const sunset = body.events.find((e) => e.type === 'sunset');
  assert(sunset?.sun?.whereToLook, '晚霞事件缺少观赏方位');
  return `${body.events.length} 条，晚霞方位「${sunset.sun.direction}」`;
});

await check('CORS 头正确', async () => {
  const res = await fetch(`${base}/v1/glow?address=${encodeURIComponent('北京')}`);
  const origin = res.headers.get('access-control-allow-origin');
  assert(origin, '缺少 access-control-allow-origin');
  return origin;
});

await check('地名逐级回退可用', async () => {
  const { body } = await getJson('/v1/geo?address=' + encodeURIComponent('杭州市西湖区'));
  assert(body.ok === true, 'ok 不为 true');
  assert(body.resolved, '没有解析出坐标');
  return `「${body.resolved.query}」→ ${body.resolved.lat}, ${body.resolved.lon}`;
});

await check('缓存生效（第二次更快且标记 cached）', async () => {
  const path = `/v1/glow?address=${encodeURIComponent('北京')}&days=1`;
  await getJson(path);
  const { body } = await getJson(path);
  assert(body.dataSources?.[0]?.cached === true, '第二次请求仍然 cached=false');
  return 'cached=true';
});

const symbols = { true: '✓', false: '✗' };
console.log(`\n自检目标：${base}\n`);
for (const r of results) {
  console.log(`  ${symbols[r.ok]} ${r.name}${r.detail ? `  —  ${r.detail}` : ''}`);
}

const failed = results.filter((r) => !r.ok).length;
console.log('');
if (failed === 0) {
  console.log(`全部通过（${results.length} 项）`);
  process.exit(0);
} else {
  console.log(`${failed} 项失败（共 ${results.length} 项）`);
  process.exit(1);
}
