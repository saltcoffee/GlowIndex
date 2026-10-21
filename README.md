# GlowIndex

[![CI](https://github.com/saltcoffee/GlowIndex/actions/workflows/ci.yml/badge.svg)](https://github.com/saltcoffee/GlowIndex/actions/workflows/ci.yml)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**可解释的朝霞 / 晚霞强度预测 API。** 传一个地址，返回今晚或明早会不会烧、烧到什么程度、为什么、几点几分该往哪边看。

[接口文档](docs/API.md) · [算法与调参](docs/ALGORITHM.md) · [参与贡献](CONTRIBUTING.md) · [安全策略](SECURITY.md)

> [!CAUTION]
> GlowIndex 只面向观赏和摄影参考。天气预报具有概率性，不应用作人身安全、航空、航海、应急规划或其他安全关键决策的唯一依据；此类场景请查阅当地官方气象机构的信息。

```
GET /v1/glow?address=北京市朝阳区
→ 今晚 17:31 前后 · 大烧 🔥 86.6 分 · 朝西偏南 258° 看
```

- **六档强度**：不烧 / 微烧 / 小烧 / 中烧 / 大烧 / 世纪大烧
- **可解释**：每个结论都带六个因子的得分和一句人话解释，不是黑盒
- **朝霞晚霞分开算**，给最佳时刻、观赏窗口、观察方位、逐时时间轴
- **免费跑在 Cloudflare Workers**：无数据库、无服务器、无需构建工具链
- 数据源：WeatherAPI（主，需免费 Key）+ MET Norway（分层云 + 温湿，免 Key、可商用）

---

## 30 秒先看效果（不需要任何 Key）

需要 Node.js 22 或更高版本。项目没有运行时依赖，克隆后可以直接启动：

```bash
git clone https://github.com/saltcoffee/GlowIndex.git
cd GlowIndex
npm run dev:mock
```

另开一个终端：

```bash
curl "http://127.0.0.1:8787/v1/glow?address=北京"
```

`--mock` 用内置的合成天气数据把整条链路跑起来，专门造了三种剧本：今天傍晚大烧、明天一般、后天雨到不烧。适合先确认输出长什么样、再决定要不要接真实数据。

## 接真实数据（需要 WeatherAPI 免费 Key）

1. 到 <https://www.weatherapi.com/signup.aspx> 注册，当前免费额度为 **10 万次/月**，控制台首页就能看到 Key。额度以 [官方定价页](https://www.weatherapi.com/pricing.aspx) 为准。
2. 把 `.dev.vars.example` 复制成 `.dev.vars`（已 gitignore），填入 Key：

   ```bash
   copy .dev.vars.example .dev.vars     # Windows
   cp .dev.vars.example .dev.vars       # macOS / Linux
   ```

   ```
   WEATHERAPI_KEY=你的key
   ```

3. 启动：

```bash
npm run dev
curl "http://127.0.0.1:8787/v1/glow?address=杭州市西湖区&days=2"
```

---

## 部署到 Cloudflare（免费）

### 路线 A：Dashboard 粘贴（不用装任何工具，推荐）

1. 打包出单文件产物：

   ```bash
   npm run build      # 生成 dist/worker.js（约 100KB，自包含）
   ```

2. Cloudflare Dashboard → **Workers & Pages** → **Create** → **Worker** → 随便起个名字（比如 `glowindex`）→ **Deploy**。
3. 点 **Edit code**，把编辑器里默认的示例代码**全部删掉**，粘贴 `dist/worker.js` 的完整内容 → **Deploy**。
4. 进这个 Worker 的 **Settings → Variables and Secrets**，添加：
   - 类型：**Secret**
   - 名称：`WEATHERAPI_KEY`
   - 值：你的 Key

   > 一定要用 Secret，不要用明文 Variable——Secret 不会出现在代码和日志里。
5. 打开 `https://<你的子域>.workers.dev/v1/glow?address=北京`，收工。

以后改了代码，重复「`npm run build` → 重新粘贴 → Deploy」即可。

### 路线 B：wrangler（改了代码能一条命令发布）

```bash
npm i -D wrangler          # 只在需要发布时装，项目本身零依赖
npx wrangler login
npx wrangler secret put WEATHERAPI_KEY
npm run deploy             # 内部会先 build，再 wrangler deploy
```

`wrangler.jsonc` 已经把入口指向 `dist/worker.js`，所以任何发布前都会先打包。

### 免费额度够不够？

| 项目 | 免费额度 | 本项目消耗 |
| --- | --- | --- |
| Cloudflare Workers | 10 万次请求/天，单次 10ms CPU | 命中缓存仍需执行评分；以部署后的 CPU 指标与压测为准 |
| Cloudflare 缓存 | Cache API 免费 | WeatherAPI 缓存 25 分钟；MET 独立按上游 `Expires` 缓存 |
| WeatherAPI | 10 万次/月，3 天预报 | 一次查询最多 1 次预报调用 |
| MET Norway | 免费、可商用、无需 Key，限 20 请求/秒 | 独立缓存未命中或需重验证时调用，失败自动降级 |

同一个地点被连续查询时，25 分钟的主源预报缓存会显著减少 WeatherAPI 调用；MET Norway 数据则独立遵守响应里的 `Expires`，过期后携带 `Last-Modified` / `ETag` 条件重验证。两份数据会在每次请求时即时合并，不会用一个来源的 TTL 遮住另一个来源。免费额度和条款可能调整，部署前请同时查看 [Cloudflare Workers 限额](https://developers.cloudflare.com/workers/platform/limits/)、[WeatherAPI 定价](https://www.weatherapi.com/pricing.aspx) 与 [MET Norway 使用条款](https://docs.api.met.no/doc/TermsOfService.html)，不要把这里的示例当成长期配额承诺。

不需要 KV / D1 / R2 / 队列；日常低流量部署可以从免费套餐开始，并按实际用量监控配额。

### 为什么用 MET Norway 而不是 Open-Meteo

早期版本用 Open-Meteo 提供分层云。当前选择 MET Norway 主要基于：

1. **授权**：Open-Meteo 的[免费 API 条款](https://open-meteo.com/en/terms)限非商业用途；MET Norway 的数据采用 CC BY 4.0，允许商用并要求署名。
2. **接入**：MET Norway 免 Key，直接提供低 / 中 / 高云量与同源温湿数据，适合保持轻量部署。

Open-Meteo 当前条款已说明 Cloudflare Workers 按 Cloudflare 用户计限流，不能再把「共享出口 IP 一定共享配额」作为当前选型依据。两家服务的限额与条款都可能调整。

代价是 **失去气溶胶 AOD**（MET Norway 不提供）。通透度因子会自动把权重重新归一化到「能见度 / 露点差 / 湿度」三项，结论仍然成立，只是少了霾/沙尘这一维。

如果以后想加回 AOD，思路是在 `buildSeries` 的 `aq` 参数里塞一个只含 `{t, aod}` 的序列——接口已经预留好了。

> MET Norway 的两个硬性要求：请求必须带**真实的 User-Agent**（含应用名和联系方式，写 `example.com` 之类占位会被 WAF 直接 403），并遵守其缓存响应头。GlowIndex 会按 `Expires` 缓存，并在过期后用验证器做条件请求。官方仓库默认使用项目 GitHub 地址；分叉部署时请通过 `METNO_USER_AGENT` 改成你自己的真实网址或邮箱。
**失败或被限流了会怎样**：MET Norway 超时、429 或 403 → `Promise.allSettled` 兜底 → 自动降级为「总云量推断分层」，此时 `dataSources[].ok=false`、`limitations` 里写明原因、`confidence` 扣 0.21。**服务不会挂**，只是精度下降。这是刻意设计的降级路径。

> WeatherAPI 当前允许免费套餐用于商业项目，但免费用户也必须标注数据来源；具体边界以其最新的[使用条款](https://www.weatherapi.com/terms)为准。

---

## 接口速览

| 参数 | 说明 | 默认 |
| --- | --- | --- |
| `address` / `q` | 地址或城市名，支持中文；会给「省→市→区」逐级回退 | — |
| `lat` `lon` | 直接给坐标，跳过地名解析 | — |
| `days` | 1–3（免费额度只给 3 天） | 2 |
| `event` | `all` / `sunrise` / `sunset`，也接受 `朝霞` `晚霞` | `all` |
| `timeline` | `0` 关掉逐时时间轴，响应更小 | 开 |
| `detail` | `brief` / `standard` / `full` | `standard` |

顶层直接给结论，前端不用翻数组。**注意 `score` / `level` 指的是"下一场"**（今晚的晚霞或明早的朝霞），不是三天里的最高分；想看"什么时候最值得出门"读 `best`：

```jsonc
{
  "ok": true,
  "score": 9.3,                                   // 下一场 = 今晚 17:31 的晚霞
  "level": { "code": "none", "name": "不烧", "emoji": "☁️" },
  "confidence": 0.94,
  "next": { "id": "2026-10-18-sunset", "label": "晚霞", "date": "2026-10-18", "eventTime": "17:31" },
  "best": { "id": "2026-10-19-sunset", "score": 97.6, "level": { "name": "世纪大烧" } },  // 明天傍晚
  "events": [ /* 每场日出日落各一条 */ ],
  "limitations": []   // 数据缺什么、结论在哪打了折扣
}
```

完整字段见 [docs/API.md](docs/API.md)。

---

## 六档强度

| 分数 | 档位 | 意味着什么 |
| --- | --- | --- |
| 0–28 | ☁️ 不烧 | 基本没有可观赏的霞光 |
| 28–44 | 🌤️ 微烧 | 天边一点淡色，聊胜于无 |
| 44–58 | 🌅 小烧 | 局部成片橙色，值得抬头 |
| 58–74 | 🌇 中烧 | 颜色明显、层次清楚，适合拍照 |
| 74–90 | 🔥 大烧 | 大片火烧云，值得专程出门 |
| 90–100 | 🔥🔥 世纪大烧 | 罕见的天幕级燃烧，需要几乎所有条件同时接近理想 |

这些阈值是拿真实天气场景反推校准过的，不是拍脑袋：晴空约 10 分、一般好天气约 48 分、教科书级约 90+。算法细节和每一根曲线见 [docs/ALGORITHM.md](docs/ALGORITHM.md)。

---

## 项目结构

```
src/
  index.js              Worker 入口：路由、参数校验、响应与错误映射
  config.js             所有可调参数（权重、阈值、窗口、缓存时间）
  services/
    load-bundle.js      上游编排、降级与各数据源的独立缓存契约
  lib/
    solar.js            太阳位置（日出日落、高度角、方位角），纯数学
    time.js             时区换算（DST、半小时时区都能正确处理）
    mathx.js            分段线性插值等数值工具
    http.js             带超时/重试、状态码与缓存头的 JSON 请求
    cache.js            稳定缓存键、Cache API + 内存兜底
    errors.js           应用层结构化错误
  adapters/
    weatherapi.js       主数据源 + 地名搜索
    metno.js            分层云（MET Norway，免 Key、可商用、失败可降级）
    geocode.js          地址 → 坐标的逐级回退
  core/
    series.js           多源数据合并、插值、缺分层时的推断
    factors.js          六个评分因子 + 可烧云量闸门
    analyze.js          事件编排：采样、取峰值、置信度
    advice.js           把因子翻译成人话
    levels.js           分数 → 档位
test/                   自动化测试（天文、模型、编排、接口、打包）
tools/mock-data.js      合成天气数据（开发/测试用，不进产物）
scripts/
  build.js              零依赖打包成单文件 Worker
  dev-server.js         本地开发服务器
docs/API.md             接口完整参考
docs/ALGORITHM.md       算法与调参手册
```

## 常用命令

```bash
npm test          # 跑全部测试
npm run build     # 打包 dist/worker.js
npm run check     # 测试 + 构建，和 CI 一致
npm run dev       # 本地起服务（真实上游）
npm run dev:mock  # 本地起服务（合成数据，无需 Key）
npm run smoke https://你的域名.workers.dev   # 部署后自检
```

`npm run smoke` 会依次检查健康检查、Key 是否配好、能否出结论、事件结构、CORS、地名回退、缓存是否生效，全绿退出码为 0。

## 调参指北

觉得「明明很好看却判成小烧」或者「一般般却给了大烧」，只需要改 `src/config.js`：

- **整体偏保守/激进** → 调 `LEVELS` 里的分数区间（其它都不用动）
- **觉得低云权重不够** → 提高 `WEIGHTS.lowCloud`，同时等量降低别的项（必须和为 1）
- **某个因子在哪一档给分不合适** → 改 `src/core/factors.js` 里对应的 `ramp([...])` 拐点

每根曲线都是分段线性，拐点就是语义，改起来不会牵一发动全身。

## 常见问题

**Q：为什么结果和我肉眼判断不一致？**
预报本身有误差，尤其是 3 天后的云量。`confidence` 是数据完整性和预报时效指标，不是档位命中概率。分层源未覆盖评分时段时会降级推断，并在 `notes` / `limitations` 说明；1.2.3 已修复将日落后的云量向前复制、导致杭州误报世纪大烧的问题，详见 [复盘](docs/ALGORITHM.md#12-2026-10-18-杭州误报复盘123-修复)。模型评估的是最佳观赏窗口内的潜力。

**Q：为什么有时没有低/中/高云，只有总云量？**
那说明 MET Norway 拿不到数据，已降级成「用总云量 + 湿度 + 能见度推断」，`limitations` 里会写明，置信度也会扣分。主流程不会因为一个附加源挂掉而失败。

**Q：能不能只算晚霞？**
`?event=sunset`，返回的事件更少、响应更小；上游天气获取策略不变。

**Q：WeatherAPI 的 Key 会不会泄露给前端？**
不会。Key 只存在于 Worker 的 Secret 里，浏览器拿不到；前端调你的 Worker 地址即可。也正因为如此，别把 Key 写进任何前端代码或公开仓库。

## 参与和安全

- 提交问题或代码前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。算法和阈值修改需要可复现样本与回归测试。
- 安全漏洞不要发公开 Issue，请按 [SECURITY.md](SECURITY.md) 私密报告。
- 社区互动遵循 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。

公开部署前请为 Worker 配置 Cloudflare WAF / Rate Limiting 或自己的访问控制，尤其要限制随机 `address` / `lat` / `lon` 造成的高基数请求，否则攻击者仍可能绕开地点缓存并耗尽 WeatherAPI 配额。`ALLOW_ORIGIN` 可以把浏览器跨域调用限制到你的前端域名，但 **CORS 不是鉴权**，不能替代限流或访问控制。

## 许可、数据来源与免责声明

代码以 [MIT License](LICENSE) 发布。上游天气数据不因本项目的代码许可证而重新授权；部署者和下游产品仍需遵守各数据源条款：

- **MET Norway** — 分层云数据采用 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)。展示时请注明 `分层云数据源：MET Norway（CC BY 4.0）；经 GlowIndex 转换与评分`，并链接其[许可说明](https://docs.api.met.no/doc/License.html)。
- **WeatherAPI.com** — 免费用户必须标注 WeatherAPI.com 为数据来源；当前套餐允许商业使用。请同时遵守其[署名说明](https://www.weatherapi.com/docs/attribution/)与[使用条款](https://www.weatherapi.com/terms)。

`GET /` 与 `GET /v1/glow` 的响应都内置了署名和免责声明信息，方便前端渲染。更完整的义务和建议文案见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

天气信息仅供一般参考，可能与特定地点和时刻的实际情况不符。请勿将其作为任何安全关键决策的唯一依据。
