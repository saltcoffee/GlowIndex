/** 带超时和一次重试的 JSON 请求。故意不引依赖，Workers 里直接可用。 */

export class UpstreamError extends Error {
  constructor(message, { code = 'UPSTREAM_ERROR', status = 0, retryable = false, body = null } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.body = body;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * GET 一个 JSON。
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs] 单次尝试的超时
 * @param {number} [opts.retries] 失败重试次数
 * @param {Function} [opts.fetchImpl] 注入用（测试里替换）
 */
export async function getJson(url, opts = {}) {
  const {
    timeoutMs = 7000,
    retries = 1,
    retryDelayMs = 250,
    headers = {},
    fetchImpl = globalThis.fetch,
  } = opts;

  if (typeof fetchImpl !== 'function') {
    throw new UpstreamError('global fetch 不可用');
  }

  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) await sleep(retryDelayMs * attempt);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetchImpl(url, {
        signal: controller.signal,
        headers: { accept: 'application/json', 'user-agent': 'huoshaoyun-api/1.0', ...headers },
      });

      const text = await res.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = null;
        }
      }

      if (!res.ok) {
        const retryable = res.status >= 500 || res.status === 429;
        if (retryable && attempt < retries) {
          lastError = new UpstreamError(`upstream HTTP ${res.status}`, {
            status: res.status,
            retryable: true,
            body: data,
          });
          continue;
        }
        throw new UpstreamError(`upstream HTTP ${res.status}`, {
          status: res.status,
          body: data,
        });
      }

      if (data == null) {
        throw new UpstreamError('upstream 返回了非 JSON 内容', { status: res.status });
      }
      return data;
    } catch (err) {
      if (err instanceof UpstreamError) {
        if (err.retryable && attempt < retries) {
          lastError = err;
          continue;
        }
        throw err;
      }
      const aborted = err?.name === 'AbortError';
      lastError = new UpstreamError(aborted ? 'upstream 请求超时' : 'upstream 网络错误', {
        retryable: true,
      });
      if (attempt >= retries) throw lastError;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError ?? new UpstreamError('upstream 请求失败');
}

/** 拼 query string，自动跳过 null/undefined。 */
export function withQuery(base, params) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    usp.set(k, String(v));
  }
  const qs = usp.toString();
  return qs ? `${base}?${qs}` : base;
}
