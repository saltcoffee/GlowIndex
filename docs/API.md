# GlowIndex 接口参考

Base URL 就是你的 Worker 域名，例如 `https://glowindex.example.workers.dev`。所有接口都是 `GET`，返回 `application/json; charset=utf-8`，并且带 CORS（默认 `access-control-allow-origin: *`），浏览器可直接调用。不需要任何鉴权头——Key 只存在 Worker 内部。

---

## 1. `GET /v1/glow`

主接口。

### 查询参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `address` | string | 二选一 | — | 地址或城市名，最长 120 字。中文会做「完整地址 → 去后缀 → 省市前缀 → 行政段」逐级回退 |
| `q` | string | 二选一 | — | `address` 的别名 |
| `lat` | number | 二选一 | — | 纬度 −90~90，必须与 `lon` 成对出现 |
| `lon` | number | 二选一 | — | 经度 −180~180 |
| `days` | int | 否 | `2` | 1~3。超过 3 会被截断并在 `limitations` 说明 |
| `event` | string | 否 | `all` | `all` / `sunrise` / `sunset`；也接受 `朝霞` `早霞` `日出` 与 `晚霞` `日落` |
| `timeline` | `0`/`1` | 否 | `1` | 是否返回逐时评分时间轴 |
| `detail` | string | 否 | `standard` | `brief` 只留结论与建议；`standard` 全量；`full` 同 standard |

### 响应结构

```jsonc
{
  "ok": true,
  "algorithm": { "id": "glowindex/1.2.3", "version": "1.2.3" },
  "generatedAt": "2026-10-18T07:20:03.114Z",

  "query": { "address": "北京", "lat": 39.9042, "lon": 116.4074, "event": "all", "days": 1, "detail": "standard" },

  "location": {
    "name": "Beijing", "region": "Beijing", "country": "China",
    "lat": 39.9042, "lon": 116.4074,
    "timezone": "Asia/Shanghai",
    "localtime": "2026-10-18 15:20",      // 上游给的本地时间串
    "localDate": "2026-10-18",
    "localClock": "15:21",                // 按 timezone 现算的当地时间
    "resolvedFrom": "search",             // search | coords
    "resolvedQuery": "北京"                // 真正命中的那一级查询串
  },

  // ↓ 顶层直接给结论：默认是"下一场"（今晚的晚霞 / 明早的朝霞）
  //   注意不是"未来三天最高分"，否则下午查会显示明天的大烧，而今晚其实不烧
  "score": 9.3,
  "level": { "code": "none", "name": "不烧", "emoji": "☁️", "summary": "…", "range": [0, 28] },
  "confidence": 0.94,
  "next": { "id": "2026-10-18-sunset", "type": "sunset", "label": "晚霞",
            "date": "2026-10-18", "eventTime": "17:31", "peakTime": "17:41" },

  // 未来 N 天里最值得看的一场，用于"什么时候值得专程出门"
  "best": { /* 完整事件对象，结构见下 */ },

  "events": [ /* 每场日出/日落一条，按时间升序 */ ],

  "levels": [ /* 六档完整定义，方便前端画图例 */ ],

  "dataSources": [
    { "name": "weatherapi", "role": "primary", "ok": true, "cached": false },
    { "name": "met.no", "role": "layered-clouds", "ok": true, "cached": false }
  ],

  "attribution": [ /* 面向最终用户展示的数据源署名 */ ],
  "disclaimer": "天气信息仅供一般参考……",

  "limitations": []   // 数据缺口的自然语言说明，空数组表示数据齐全
}
```

### 事件对象（`best` / `events[]`）

```jsonc
{
  "id": "2026-10-18-sunset",
  "type": "sunset",              // sunset | sunrise
  "label": "晚霞",
  "date": "2026-10-18",

  "eventTime": "17:31",          // 官方日落时刻
  "peakTime": "17:31",           // 模型认为色彩最浓的时刻
  "peakOffsetMin": 0,            // peakTime 相对 eventTime 的分钟差，正数表示之后
  "window": { "start": "16:56", "end": "17:51", "durationMin": 55 },

  "score": 95.6,
  "level": { "code": "epic", "name": "世纪大烧", "emoji": "🔥🔥", "summary": "…", "range": [90, 100] },

  "sun": {
    "elevationAtPeak": -0.81,    // 度，负值表示太阳在地平线以下
    "azimuthAtPeak": 258,        // 度，自正北顺时针
    "elevationAtEvent": -0.81,
    "azimuthAtEvent": 258,
    "direction": "西偏南",
    "whereToLook": "朝 西偏南 方向（方位角 258°）看"
  },

  "factors": [                   // 恒定 6 项，权重和为 1
    {
      "key": "canvas", "name": "中高云画布",
      "score": 0.98,             // 0~1，该因子自己的得分
      "weight": 0.34,
      "contribution": 33.3,      // score × weight × 100，六项相加 = base
      "detail": "中云 35% / 高云 55%，正处在最容易出彩的云量区间"
    }
  ],

  "modifiers": [                 // 修正项，可能为空
    { "key": "canvasGate", "name": "可烧云量", "effect": "×0.58", "detail": "…" }
  ],

  "weather": {
    "cloudTotal": 64, "cloudLow": 12, "cloudMid": 35, "cloudHigh": 55,
    "layered": true,             // 峰值时刻有有效分层数据；false 表示由该时刻基础天气推断
    "humidity": 46, "tempC": 25.1, "dewpointC": 12.1,
    "visKm": 22, "windKph": 12, "gustKph": 20,
    "precipMm": 0, "chanceOfRain": 0,
    "aod": null,                 // 气溶胶光学厚度；当前数据源不提供，固定为 null
    "condition": "Partly cloudy"
  },

  "timeline": [                  // 峰值窗口内每 10 分钟一个点，最多 14 个
    { "time": "17:01", "elevation": 2.6, "score": 94.7, "level": "世纪大烧",
      "cloudLow": 12, "cloudMid": 35, "cloudHigh": 55, "precipMm": 0 }
  ],

  "advice": ["低云 12%，地平线干净，光路通畅", "建议提前 25 分钟到位…"],

  "confidence": 0.94,            // 0.35~0.98，数据完整性/时效指标，不是档位命中概率
  "notes": []                    // 这一场特有的数据说明
}
```

### 强度档位

| `level.code` | `level.name` | 分数区间 | emoji |
| --- | --- | --- | --- |
| `none` | 不烧 | 0 ≤ s < 28 | ☁️ |
| `slight` | 微烧 | 28 ≤ s < 44 | 🌤️ |
| `mild` | 小烧 | 44 ≤ s < 58 | 🌅 |
| `moderate` | 中烧 | 58 ≤ s < 74 | 🌇 |
| `big` | 大烧 | 74 ≤ s < 90 | 🔥 |
| `epic` | 世纪大烧 | 90 ≤ s ≤ 100 | 🔥🔥 |

### 示例

```bash
# 最常用：给个地址
curl "https://<你的域名>/v1/glow?address=北京市朝阳区"

# 只看今晚的晚霞，只要结论
curl "https://<你的域名>/v1/glow?address=杭州&event=sunset&detail=brief"

# 三天，带时间轴
curl "https://<你的域名>/v1/glow?address=成都&days=3"

# 坐标直传（不确定地名解析时最稳）
curl "https://<你的域名>/v1/glow?lat=39.9042&lon=116.4074&event=sunrise"
```

---

## 2. `GET /v1/geo`

地名解析调试接口。**不消耗预报配额**，用来确认「你说的那个地址，系统到底解析到哪」。

```bash
curl "https://<你的域名>/v1/geo?address=杭州市西湖区"
```

```jsonc
{
  "ok": true,
  "input": "杭州市西湖区",
  "candidatesTried": ["杭州市西湖区", "杭州市西湖", "杭州市", "杭州", "西湖"],
  "resolved": {
    "lat": 30.2741, "lon": 120.1551,
    "name": "Hangzhou", "region": "Zhejiang", "country": "China",
    "query": "杭州市",          // 真正命中的那一级
    "resolved": "search",
    "tried": ["杭州市西湖区", "杭州市西湖", "杭州市"]
  }
}
```

---

## 3. `GET /health`

健康检查，不访问任何上游，适合做可用性探针。

```jsonc
{ "ok": true, "version": "1.2.3", "algorithm": "glowindex/1.2.3",
  "configured": true, "time": "2026-10-18T07:21:00.000Z" }
```

`configured: false` 表示没配 `WEATHERAPI_KEY`，此时 `/v1/glow` 会直接返回 500 并说明原因。

---

## 4. `GET /`

接口自述，返回路由、参数、档位、数据署名与免责声明。用来在浏览器里直接确认服务活着。

## 5. 数据署名与免责声明

`GET /` 与 `GET /v1/glow` 的 `attribution` 和 `disclaimer` 字段给出面向最终用户的基础文案。使用这些数据的网站或应用应在界面中清晰展示：

- `Powered by WeatherAPI.com`，并链接到 <https://www.weatherapi.com/>；
- `分层云数据源：MET Norway（CC BY 4.0）；经 GlowIndex 转换与评分`，并链接到 [MET Norway 许可说明](https://docs.api.met.no/doc/License.html) 与 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)；
- 天气预测仅供一般参考，不作为人身安全、航空、航海、应急规划或其他安全关键决策的唯一依据。

完整说明见 [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md)。

---

## 错误响应

所有错误都是同一种结构，`ok` 恒为 `false`：

```jsonc
{
  "ok": false,
  "error": {
    "code": "LOCATION_NOT_FOUND",
    "message": "没有解析出「完全不存在的地方xyz」的坐标",
    "hint": "试试只传城市名（北京、杭州、成都），或直接给 lat/lon 参数"
  }
}
```

| HTTP | `error.code` | 含义 | 怎么办 |
| --- | --- | --- | --- |
| 400 | `MISSING_QUERY` | 既没给 `address` 也没给坐标 | 补参数 |
| 400 | `INVALID_COORDINATE` | 坐标越界，或只给了 `lat`/`lon` 中的一个 | 两个一起给 |
| 400 | `ADDRESS_TOO_LONG` | 地址超过 120 字 | 只传城市/区县 |
| 400 | `INVALID_EVENT` | `event` 不是 all/sunrise/sunset | 改参数 |
| 404 | `LOCATION_NOT_FOUND` | 地名没解析出来 | 换城市名或直接给坐标 |
| 404 | `NOT_FOUND` | 路由不存在 | 检查路径 |
| 405 | `METHOD_NOT_ALLOWED` | 用了 POST 等 | 只支持 GET |
| 500 | `MISSING_API_KEY` | 服务端没配 `WEATHERAPI_KEY` | 设置 Secret |
| 500 | `INTERNAL_ERROR` | 未预期的内部错误 | 看 `error.detail` |
| 502 | `WEATHERAPI_1006` | 上游找不到该坐标 | 换坐标 |
| 502 | `WEATHERAPI_2006` | Key 无效 | 检查 Secret 有没有多余空格/引号 |
| 502 | `WEATHERAPI_2007` | 本月配额用尽 | 等下月或换 Key |
| 502 | `WEATHERAPI_2008` / `2009` | Key 被停用/失效 | 重新签发 |
| 502 | `UPSTREAM_ERROR` | 主数据源超时或网络错误 | 稍后重试 |
| 502 | `UPSTREAM_EMPTY` | 上游返回的逐小时数据为空 | 换地点或稍后重试 |
| 502 | `NO_EVENT` | 没构建出任何日出日落（如极昼极夜） | 换地点 |

---

## 缓存与一致性

- 缓存**不是**缓存最终响应，而是缓存三类内部数据：**WeatherAPI 归一化预报**（键为 `版本 + lat/lon/days`）、**MET Norway 分层云与验证器**（键为坐标）和**地名解析结果**。两份天气数据会在每次请求时即时合并。
- 因此 `now / best / next` 的判断永远是请求当下的，不会拿到一份「昨晚的结论」。
- WeatherAPI TTL **25 分钟**，地名 TTL **7 天**。MET Norway 独立遵守响应里的 `Expires`；到期后的下一次请求使用 `Last-Modified` / `ETag` 条件重验证，没提供有效缓存头时按 1 小时兜底。
- `dataSources[].cached` 分别表示该来源是否从缓存复用；两个来源互不遮蔽，也不要求同时刷新。
- WeatherAPI 缓存键包含**算法版本号**（如 `v=1.2.3`）：升级后旧的归一化结果自动失效；MET 原始分层云缓存与算法版本解耦，在仍新鲜时可继续复用。
- 各命名空间只使用与自身语义有关的版本、坐标、`days` 或地址文本；添加陌生查询参数**不会**绕过缓存。这是故意的：避免有人用随机参数把上游免费额度刷光。
- `days` 会改变 WeatherAPI 缓存键和 MET 返回裁剪范围，但不会让仍新鲜的 MET 数据重复下载。要调整刷新策略，请改 `src/config.js` 中对应 TTL，并继续遵守上游缓存要求。

## 部署安全

- 接口默认不鉴权且 `access-control-allow-origin: *`，适合本地体验，不代表公开实例天然具备滥用防护。
- 上线前建议在 Cloudflare 配置 WAF / Rate Limiting 或自己的访问控制，重点限制随机 `address` / `lat` / `lon` 形成的高基数请求，避免 WeatherAPI 月度配额被消耗。
- 可以设置 `ALLOW_ORIGIN=https://你的前端域名` 收紧浏览器跨域访问；**CORS 不是鉴权**，非浏览器客户端仍可直接请求。
