import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from '../scripts/build.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = path.join(ROOT, 'dist', 'worker.js');

describe('单文件打包（Dashboard 粘贴部署用）', () => {
  it('能生成自包含产物并当 Worker 跑起来', async () => {
    build();

    assert.ok(fs.existsSync(OUT), 'dist/worker.js 应该存在');
    const code = fs.readFileSync(OUT, 'utf8');

    assert.ok(code.includes('export default'), '产物必须导出 default');
    assert.ok(!/^import\s/m.test(code), '产物里不应残留 import 语句（否则无法直接粘贴）');
    assert.ok(code.includes('forecast.json'), '应该打包进了 WeatherAPI 适配器');
    assert.ok(code.includes('cloud_area_fraction_high'), '应该打包进了 MET Norway 适配器');

    const mod = await import(`${pathToFileURL(OUT).href}?v=${Date.now()}`);
    assert.equal(typeof mod.default.fetch, 'function');

    const { createMockFetch } = await import('../tools/mock-data.js');
    const env = { WEATHERAPI_KEY: 'k', fetchImpl: createMockFetch() };
    const res = await mod.default.fetch(
      new Request('https://api.example.test/v1/glow?address=北京'),
      env,
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(body.events.length >= 2);
    assert.ok(body.level.name.length > 0);
  });

  it('产物大小适合 Dashboard 编辑器（远小于 1MB 免费上限）', () => {
    const bytes = fs.statSync(OUT).size;
    assert.ok(bytes < 200 * 1024, `产物 ${(bytes / 1024).toFixed(1)}KB，偏大`);
  });
});
