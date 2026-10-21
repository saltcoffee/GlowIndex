# 第三方数据说明

GlowIndex 的 MIT License 只覆盖本仓库代码。运行时取得的天气数据仍受其提供方条款约束，部署者和下游产品需要自行持续核对最新条款。以下信息最后核对于 2026-10-21。

## WeatherAPI.com

- 用途：地点解析、逐小时天气、能见度、风、降水和日出日落数据。
- 数据不会随本仓库分发，而是在部署实例运行时使用部署者自己的 API Key 请求。
- 免费用户需要在面向最终用户的界面标注 `Powered by WeatherAPI.com`，并链接到 <https://www.weatherapi.com/>。
- 套餐、配额与商业使用范围以 [Pricing](https://www.weatherapi.com/pricing.aspx) 和 [Terms](https://www.weatherapi.com/terms) 为准。

## MET Norway

- 用途：低云、中云、高云以及同源温湿数据。
- 数据采用 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) 等开放许可，详见 [MET Norway Licensing and Data Policy](https://docs.api.met.no/doc/License.html)。
- GlowIndex 会对原始数据做字段归一、时间插值、降级推断和评分。建议展示：`分层云数据源：MET Norway（CC BY 4.0）；经 GlowIndex 转换与评分`。
- 客户端还必须遵守 [MET Weather API Terms of Service](https://docs.api.met.no/doc/TermsOfService.html)，包括真实 User-Agent、缓存和流量限制要求。

以上署名不得暗示 WeatherAPI.com 或 MET Norway 认可、担保或参与维护 GlowIndex。

## 最终用户免责声明

天气信息仅供一般参考。预报具有概率性，可能与特定地点和时刻的实际情况不符；请勿将其作为人身安全、航空、航海、应急规划或其他安全关键决策的唯一依据，并应查阅当地官方气象机构发布的信息。
