/**
 * 本地开发服务器：直接用 Node 跑 Worker 代码，不需要 wrangler。
 *
 *   node scripts/dev-server.js           # 真实上游（需要 .dev.vars 里的 WEATHERAPI_KEY）
 *   node scripts/dev-server.js --mock    # 全离线，用合成数据（不需要任何 Key）
 *
 * .dev.vars 格式（也是 wrangler 的本地密钥文件格式）：
 *   WEATHERAPI_KEY=你的key
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import worker from '../src/index.js';
import { createMockFetch } from '../tools/mock-data.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const argv = new Set(process.argv.slice(2));
const USE_MOCK = argv.has('--mock');
const PORT = Number(process.env.PORT || 8787);

/** 读取 wrangler 风格的 .dev.vars。 */
function loadDevVars(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

const env = { ...loadDevVars(path.join(ROOT, '.dev.vars')) };
for (const key of ['WEATHERAPI_KEY', 'ALLOW_ORIGIN', 'DEFAULT_DAYS', 'METNO_USER_AGENT']) {
  if (process.env[key]) env[key] = process.env[key];
}

if (USE_MOCK) {
  env.WEATHERAPI_KEY = env.WEATHERAPI_KEY || 'mock-key-not-used';
  env.fetchImpl = createMockFetch();
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host ?? `localhost:${PORT}`}`);
  } catch {
    res.writeHead(400).end('bad url');
    return;
  }

  const request = new Request(url, { method: req.method, headers: req.headers });

  try {
    const response = await worker.fetch(request, env, {});
    const body = await response.text();
    const headers = {};
    response.headers.forEach((v, k) => {
      headers[k] = v;
    });
    res.writeHead(response.status, headers).end(body);
    console.log(
      `${String(req.method).padEnd(6)} ${url.pathname}${url.search} → ${response.status} (${Date.now() - started}ms)`,
    );
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: { message: String(err?.stack ?? err) } }, null, 2));
    console.error('请求处理失败:', err);
  }
});

server.listen(PORT, () => {
  const base = `http://127.0.0.1:${PORT}`;
  console.log('');
  console.log(`GlowIndex 已启动：${base}`);
  console.log(`模式：${USE_MOCK ? '离线合成数据（--mock）' : '真实上游'}`);
  if (!USE_MOCK && !env.WEATHERAPI_KEY) {
    console.log('');
    console.log('⚠️  没读到 WEATHERAPI_KEY。两种做法：');
    console.log('   1) 在 .dev.vars 里写 WEATHERAPI_KEY=你的key');
    console.log('   2) 或加 --mock 参数，用合成数据先看效果');
  }
  console.log('');
  console.log('试一下：');
  console.log(`  ${base}/v1/glow?address=北京`);
  console.log(`  ${base}/v1/glow?address=杭州市西湖区&days=2`);
  console.log(`  ${base}/v1/glow?lat=39.9042&lon=116.4074&event=sunset`);
  console.log(`  ${base}/health`);
  console.log('');
});
