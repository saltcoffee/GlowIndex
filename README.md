# 火烧云 API · 朝霞晚霞强度查询

传一个地址，返回**今晚/明早会不会烧、烧到什么程度、为什么、几点几分该往哪边看**。

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

```bash
npm run dev:mock
```

另开一个终端：

```bash
curl "http://127.0.0.1:8787/v1/glow?address=北京"
```

`--mock` 用内置的合成天气数据把整条链路跑起来，专门造了三种剧本：今天傍晚大烧、明天一般、后天雨到不烧。适合先确认输出长什么样、再决定要不要接真实数据。

## 接真实数据（需要 WeatherAPI 免费 Key）

1. 到 <https://www.weatherapi.com/signup.aspx> 注册，免费额度 **100 万次/月**，控制台首页就能看到 Key。
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
   npm run build      # 生成 dist/worker.js（约 95KB，自包含）
   ```

2. Cloudflare Dashboard → **Workers & Pages** → **Create** → **Worker** → 随便起个名字（比如 `huoshaoyun`）→ **Deploy**。
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
| Cloudflare Workers | 10 万次请求/天，单次 10ms CPU | 单次计算约 2–4ms，纯计算无 IO 阻塞 |
| Cloudflare 缓存 | Cache API 免费 | 缓存天气包 25 分钟 |
| WeatherAPI | 100 万次/月，3 天预报 | 一次查询最多 1 次预报调用 |
| MET Norway | 免费、可商用、无需 Key，限 20 请求/秒 | 每次查询 1 次（分层云），失败自动降级 |

算一下：同一个地点被连续查询一整天，因为缓存 25 分钟，最多也只消耗 **约 58 次** WeatherAPI 调用和 **约 58 次** MET Norway 调用。100 万/月 ≈ 3.3 万次/天，够 **500 多个地点**全天候盯着。个人和小团队用，基本不会触顶。

不需要 KV / D1 / R2 / 队列——这是刻意设计的：全部落在免费额度内。

### 为什么用 MET Norway 而不是 Open-Meteo

早期版本用 Open-Meteo 提供分层云，后来换掉了，原因有两条：

1. **授权**：Open-Meteo 免费额度仅限**非商业用途**；MET Norway 的数据是 CC BY 4.0，**允许商用**，只要署名。
2. **额度归属**：Open-Meteo 免费版按**源 IP** 限「1 万次/天、5 千次/时、600 次/分」，而 Worker 的出口 IP 是 **Cloudflare 的共享 IP**——额度不是你独享的，可能被同一出口上的其他应用挤到 429。MET Norway 只限 20 请求/秒，没有每日上限。

代价是 **失去气溶胶 AOD**（MET Norway 不提供）。通透度因子会自动把权重重新归一化到「能见度 / 露点差 / 湿度」三项，结论仍然成立，只是少了霾/沙尘这一维。

如果以后想加回 AOD，思路是在 `buildSeries` 的 `aq` 参数里塞一个只含 `{t, aod}` 的序列——接口已经预留好了。

> MET Norway 的两个硬性要求：请求必须带**真实的 User-Agent**（含应用名和联系方式，写 `example.com` 之类占位会被 WAF 直接 403），以及必须缓存。默认 UA 在 `src/adapters/metno.js` 里，部署前请改成你自己的网址或邮箱。
**失败或被限流了会怎样**：MET Norway 超时、429 或 403 → `Promise.allSettled` 兜底 → 自动降级为「总云量推断分层」，此时 `dataSources[].ok=false`、`limitations` 里写明原因、`confidence` 扣 0.21。**服务不会挂**，只是精度下降。这是刻意设计的降级路径。

> ⚠️ 免费额度仅限**非商业用途**。如果要做成收费产品、或挂在商业产品里，按条款需要购买商业授权（有独立服务器 + API Key，无每日上限）。

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
  index.js              Worker 入口：路由、参数校验、缓存、错误码
  config.js             所有可调参数（权重、阈值、窗口、缓存时间）
  lib/
    solar.js            太阳位置（日出日落、高度角、方位角），纯数学
    time.js             时区换算（DST、半小时时区都能正确处理）
    mathx.js            分段线性插值等数值工具
    http.js             带超时/重试的 JSON 请求
    cache.js            Cache API + 内存兜底
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
test/                   58 个测试（天文、模型、编排、接口、打包）
tools/mock-data.js      合成天气数据（开发/测试用，不进产物）
scripts/
  build.js              零依赖打包成单文件 Worker
  dev-server.js         本地开发服务器
docs/API.md             接口完整参考
docs/ALGORITHM.md       算法与调参手册
```

## 常用命令

```bash
npm test          # 跑全部测试（58 个）
npm run build     # 打包 dist/worker.js
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
预报本身有误差，尤其是 3 天后的云量。我们给了 `confidence` 字段：低于 0.6 时建议临近时段再看一次。另外模型看的是「最佳观赏窗口内的潜力」，不是某一瞬间。

**Q：为什么有时没有低/中/高云，只有总云量？**
那说明 MET Norway 拿不到数据，已降级成「用总云量 + 湿度 + 能见度推断」，`limitations` 里会写明，置信度也会扣分。主流程不会因为一个附加源挂掉而失败。

**Q：能不能只算晚霞？**
`?event=sunset`，响应体积和上游调用都会更少。

**Q：WeatherAPI 的 Key 会不会泄露给前端？**
不会。Key 只存在于 Worker 的 Secret 里，浏览器拿不到；前端调你的 Worker 地址即可。也正因为如此，别把 Key 写进任何前端代码或公开仓库。

## 许可与署名

代码本身 MIT。但**数据源有署名要求**，对外提供服务时请务必保留：

- **MET Norway** — 分层云数据，授权 **CC BY 4.0**。要求：署名 + 注明许可 + 说明是否改动。建议在页面底部写：`分层云数据来自 MET Norway（CC BY 4.0）`，并链接到 <https://www.met.no/>。
- **WeatherAPI.com** — 按其免费套餐条款使用（非商业）。如果做商业产品，需要升级到其付费方案。

`GET /` 的响应里已经内置了 `attribution` 字段，方便前端直接渲染。

代码本身以 **MIT** 许可发布。
