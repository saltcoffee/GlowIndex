/**
 * 缓存。
 *
 * Workers 里用 Cache API（免费、无需 KV）；本地 Node / 测试环境自动退回内存 Map。
 * 缓存的是归一化天气数据和上游缓存元数据，不是最终响应——这样同一份天气数据
 * 可以服务多条查询，也能显著压低上游调用量。
 */

import { CACHE_TTL } from '../config.js';

const memory = new Map(); // key -> {value, exp}
const CACHE_HOST = 'https://cache.glowindex.internal';

/** 创建只在内部 Cache API 使用的稳定 URL。 */
export function createCacheKey(namespace, params = {}) {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value != null) usp.set(key, String(value));
  }
  const query = usp.toString();
  return `${CACHE_HOST}/${namespace}${query ? `?${query}` : ''}`;
}

function memorySet(key, value, ttlSec) {
  if (memory.size >= CACHE_TTL.memoryMax) {
    // 简单淘汰：删掉最早插入的一批
    const drop = Math.ceil(CACHE_TTL.memoryMax * 0.2);
    let i = 0;
    for (const k of memory.keys()) {
      memory.delete(k);
      if (++i >= drop) break;
    }
  }
  memory.set(key, { value, exp: Date.now() + ttlSec * 1000 });
}

function memoryGet(key) {
  const hit = memory.get(key);
  if (!hit) return null;
  if (hit.exp < Date.now()) {
    memory.delete(key);
    return null;
  }
  return hit.value;
}

function defaultCache() {
  try {
    if (typeof caches !== 'undefined' && caches.default) return caches.default;
  } catch {
    /* 忽略：非 Workers 环境 */
  }
  return null;
}

/**
 * @param {string} key 稳定的缓存键字符串
 * @returns {Promise<{value: any, cached: true}|null>}
 */
export async function readCache(key) {
  const cache = defaultCache();
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) {
        const value = await hit.json();
        return { value, cached: true };
      }
      return null;
    } catch {
      /* 落到内存兜底 */
    }
  }
  const value = memoryGet(key);
  return value == null ? null : { value, cached: true };
}

/**
 * @param {string} key
 * @param {any} value 可 JSON 序列化的值
 * @param {number} ttlSec 有效期（秒）
 */
export async function writeCache(key, value, ttlSec) {
  const cache = defaultCache();
  if (cache) {
    try {
      await cache.put(
        key,
        new Response(JSON.stringify(value), {
          headers: {
            'content-type': 'application/json',
            'cache-control': `public, max-age=${ttlSec}`,
          },
        }),
      );
      return;
    } catch {
      /* 落到内存兜底 */
    }
  }
  memorySet(key, value, ttlSec);
}

/** 读不到就生产并写入。返回 {value, cached}。 */
export async function cachedFetch(key, ttlSec, producer) {
  const hit = await readCache(key);
  if (hit) return hit;
  const value = await producer();
  await writeCache(key, value, ttlSec);
  return { value, cached: false };
}

/** 仅供测试与本地开发：清空内存缓存。 */
export function clearMemoryCache() {
  memory.clear();
}
