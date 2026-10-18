/**
 * 把 src/ 下的 ES 模块打成**单个自包含 worker.js**。
 *
 * 为什么自己写：项目零依赖，不装 esbuild/wrangler 也能出产物，
 * 这样你可以直接把 dist/worker.js 粘到 Cloudflare Dashboard 的编辑器里发布。
 *
 * 支持的语法（够用且刻意保持简单）：
 *   import { a, b } from './x.js'      → const { a, b } = __req("...")
 *   import util from './x.js'          → const util = __req("...").default
 *   export const/let/var/function/class NAME
 *   export default EXPR
 *   export { a, b }
 * 不支持：动态 import、命名空间 import、循环依赖（本项目没有）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const ENTRY = 'src/index.js';
const OUT = path.join(ROOT, 'dist', 'worker.js');

const records = new Map();
const visiting = new Set();

const toId = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');

function resolveDep(fromId, spec) {
  if (!spec.startsWith('.')) {
    throw new Error(`只支持相对路径 import，遇到 "${spec}"（来自 ${fromId}）`);
  }
  const abs = path.resolve(path.dirname(path.join(ROOT, fromId)), spec);
  if (!fs.existsSync(abs)) throw new Error(`找不到模块 "${spec}"（被 ${fromId} 引用）`);
  return toId(abs);
}

function transform(id) {
  if (records.has(id)) return records.get(id);
  if (visiting.has(id)) throw new Error(`检测到循环依赖：${id}`);

  visiting.add(id);
  const src = fs.readFileSync(path.join(ROOT, id), 'utf8');
  const names = new Set();
  const deps = [];
  let hasDefault = false;

  // 1) 具名导入（允许跨行）
  let body = src.replace(
    /^import\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"];?/gm,
    (_m, list, spec) => {
      const depId = resolveDep(id, spec);
      deps.push(depId);
      const binding = list
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .join(', ');
      return `const { ${binding} } = __req(${JSON.stringify(depId)});`;
    },
  );

  // 2) 默认导入
  body = body.replace(
    /^import\s+([A-Za-z0-9_$]+)\s+from\s*['"]([^'"]+)['"];?/gm,
    (_m, name, spec) => {
      const depId = resolveDep(id, spec);
      deps.push(depId);
      return `const ${name} = __req(${JSON.stringify(depId)}).default;`;
    },
  );

  // 3) export default
  body = body.replace(/export\s+default\s+/g, () => {
    hasDefault = true;
    return 'const __default__ = ';
  });

  // 4) 具名声明导出
  body = body.replace(
    /export\s+(async\s+function|function|class|const|let|var)\s+([A-Za-z0-9_$]+)/g,
    (_m, kw, name) => {
      names.add(name);
      return `${kw} ${name}`;
    },
  );

  // 5) 再导出清单
  body = body.replace(/export\s*\{([^}]*)\};?/g, (_m, list) => {
    for (const piece of list.split(',')) {
      const t = piece.trim();
      if (!t) continue;
      const asMatch = /\bas\s+([A-Za-z0-9_$]+)$/.exec(t);
      names.add(asMatch ? asMatch[1] : t.split(/\s+/)[0]);
    }
    return '';
  });

  if (/^\s*export\s/m.test(body)) {
    throw new Error(`${id} 里还有没处理的 export 语法，请检查`);
  }

  const rec = { id, body, names: [...names], hasDefault, deps };
  records.set(id, rec);
  visiting.delete(id);

  for (const dep of deps) transform(dep);
  return rec;
}

function indent(text, spaces) {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => (line.trim() === '' ? '' : pad + line))
    .join('\n');
}

export function build() {
  transform(ENTRY);
  const entry = records.get(ENTRY);
  if (!entry?.hasDefault) throw new Error(`${ENTRY} 必须 export default 一个 Worker 入口`);

  const defs = [...records.values()]
    .map((rec) => {
      const fields = [...rec.names];
      if (rec.hasDefault) fields.push('default: __default__');
      const ret = fields.length ? `{ ${fields.join(', ')} }` : '{}';
      return `  ${JSON.stringify(rec.id)}: () => {\n${indent(rec.body, 4)}\n    return ${ret};\n  },`;
    })
    .join('\n');

  const modules = [...records.keys()].sort();
  const out = `/**
 * 火烧云（朝霞/晚霞）强度查询 API —— 单文件 Worker 产物
 *
 * 由 scripts/build.js 从 src/ 自动生成，请勿手动修改。
 * 部署：把本文件内容粘贴到 Cloudflare Dashboard 的 Worker 编辑器中，
 *       或执行 npx wrangler deploy。
 *
 * 打包的模块（${modules.length} 个）：
${modules.map((m) => ` *   - ${m}`).join('\n')}
 */

const __defs = {
${defs}
};

const __instances = new Map();
function __req(id) {
  if (__instances.has(id)) return __instances.get(id);
  const factory = __defs[id];
  if (!factory) throw new Error('模块未被打包: ' + id);
  const resolved = factory();
  __instances.set(id, resolved);
  return resolved;
}

const __entry = __req(${JSON.stringify(ENTRY)});
export default __entry.default;
`;

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, out, 'utf8');

  const kb = (Buffer.byteLength(out, 'utf8') / 1024).toFixed(1);
  console.log(`✓ 已生成 dist/worker.js（${kb} KB，${records.size} 个模块）`);
  for (const m of modules) console.log(`  - ${m}`);
}

// 作为脚本直接执行时才真正打包；被 import 时只暴露 build()
const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) build();
