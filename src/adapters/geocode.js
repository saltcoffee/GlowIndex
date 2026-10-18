/**
 * 地址 → 经纬度。
 *
 * WeatherAPI 的 q 参数能识别城市名，但对"北京市朝阳区望京街道"这种颗粒度基本无解，
 * 所以这里逐级"往上报"：完整地址 → 省/市级前缀 → 逐段前缀 → 各行政段单独查。
 * 只要有一级命中就返回，并把尝试过程透出来，方便排查。
 */

import { searchLocations } from './weatherapi.js';

const ADMIN_TAIL = /(特别行政区|自治区|自治州|自治县|新区|开发区|高新区|旅游度假区|省|市辖区|市|地区|盟|县|区|旗|镇|乡|街道|办事处|居委会|村委会)$/;
const ADMIN_HEAD = /^(中华人民共和国|中国)[的]?/;

/** 中文字符占比够高就当中文地址处理。 */
export function looksChinese(s) {
  const str = String(s ?? '');
  if (!str) return false;
  const han = (str.match(/[\u4e00-\u9fa5]/g) ?? []).length;
  return han >= 2;
}

/**
 * 生成候选查询串，从最精确到最宽松。
 * 去重、保持顺序，保证"越具体的先试"。
 */
export function addressCandidates(raw) {
  const out = [];
  const push = (s) => {
    const v = String(s ?? '').replace(/\s+/g, ' ').trim();
    if (v && v.length <= 80 && !out.includes(v)) out.push(v);
  };

  let s = String(raw ?? '')
    .replace(/[，,、;；]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(ADMIN_HEAD, '');
  push(s);

  // 1) 逐级去掉末尾行政区划后缀
  let t = s;
  for (let i = 0; i < 8; i += 1) {
    const next = t.replace(ADMIN_TAIL, '').trim();
    if (!next || next === t) break;
    t = next;
    push(t);
  }

  // 2) 中文：按 省/市 边界截断的各级前缀
  if (looksChinese(s)) {
    const bounds = [...s.matchAll(/[省市]/g)].map((m) => m.index + 1);
    for (const b of bounds) push(s.slice(0, b));
    // 3) 各行政段单独查（如 "广东省 深圳市 南山区" → 深圳市）
    const segments = s.split(/([省市])/).reduce((acc, part, i, arr) => {
      if (i % 2 === 0 && part) acc.push(part + (arr[i + 1] ?? ''));
      return acc;
    }, []);
    for (const seg of segments) push(seg.replace(ADMIN_TAIL, ''));
  } else {
    // 4) 西文：按逗号/空格逐段从尾部剥离（"123 Main St, Springfield, IL" → "Springfield, IL"）
    const tokens = s.split(' ').filter(Boolean);
    for (let n = tokens.length; n > 1; n -= 1) push(tokens.slice(0, n - 1).join(' '));
  }

  return out;
}

/**
 * @param {object} params
 * @param {string} [params.address] 用户输入
 * @param {number} [params.lat]
 * @param {number} [params.lon]
 * @param {string} params.key
 * @param {Function} [params.fetchImpl]
 * @returns {Promise<{lat: number, lon: number, name: string|null, region: string|null,
 *                    country: string|null, query: string|null, resolved: 'coords'|'search',
 *                    tried: string[]} | null>}
 */
export async function resolveLocation({ address, lat, lon, key, fetchImpl }) {
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    return {
      lat,
      lon,
      name: null,
      region: null,
      country: null,
      query: `${lat},${lon}`,
      resolved: 'coords',
      tried: [],
    };
  }
  if (!address) return null;

  const candidates = addressCandidates(address);
  const hit = await searchLocations({ key, candidates, fetchImpl });
  if (!hit || hit.candidates.length === 0) return null;

  // 中文地址优先挑中国的结果，避免 "南京" 命中日本南城市之类的尴尬
  const preferChina = looksChinese(address);
  const pick =
    (preferChina && hit.candidates.find((c) => /china|中国/i.test(c.country ?? ''))) ||
    hit.candidates[0];

  const pLat = Number(pick.lat);
  const pLon = Number(pick.lon);
  if (!Number.isFinite(pLat) || !Number.isFinite(pLon)) return null;

  return {
    lat: pLat,
    lon: pLon,
    name: pick.name ?? null,
    region: pick.region ?? null,
    country: pick.country ?? null,
    query: hit.query,
    resolved: 'search',
    tried: hit.tried,
  };
}
