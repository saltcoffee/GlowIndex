# 为 GlowIndex 做贡献

感谢你愿意改进 GlowIndex。为了让算法、接口和文档能够一起长期演进，请先阅读下面的约定。

## 开始之前

- Bug 和功能建议请优先使用仓库的 Issue 表单。
- 大范围重构、接口变更或评分模型调整，请先开 Issue 说明目标、边界和验证方式，避免双方重复工作。
- 安全漏洞不要公开披露，请按 [SECURITY.md](SECURITY.md) 私密报告。
- 请勿提交 WeatherAPI Key、`.dev.vars`、精确住址或其他敏感信息。复现地点通常提供城市级信息即可。

## 本地开发

需要 Node.js 22 或更高版本。核心项目没有运行时依赖。

```bash
git clone https://github.com/saltcoffee/GlowIndex.git
cd GlowIndex
npm run dev:mock
```

常用验证命令：

```bash
npm test
npm run build
npm run check
```

连接真实数据时，将 `.dev.vars.example` 复制为 `.dev.vars` 并配置自己的 `WEATHERAPI_KEY`。该文件已被 Git 忽略。

## 设计与代码约定

- 保持协议、领域计算、上游适配和缓存边界清晰；在边界处校验并转换数据。
- 单个模块只承担一个清晰职责，文件接近 600 行时优先调整模块边界。
- 优先复用已有业务能力，但不要为单一用例增加推测性抽象。
- 保持 ES Modules、2 空格缩进和现有命名风格；新增依赖必须说明必要性与运行成本。
- 用户流程和上游调用要覆盖成功、空数据、错误、超时、降级与重试。
- 内部重构直接移除过时实现，不增加兼容层；公开 API 的破坏性变更必须在 Issue 和文档中明确说明。

评分曲线、阈值或数据融合逻辑的修改还需要：

1. 提供可复现的气象样本或事实依据；
2. 添加能在离线环境运行的回归测试；
3. 同步更新 `docs/ALGORITHM.md`；
4. 如果响应结构或行为改变，同步更新 `docs/API.md`。

## Pull Request

一个 PR 应围绕一个明确目标。提交前请确认：

- `npm run check` 通过；
- 新行为有自动化测试，失败和降级路径也被覆盖；
- README、API 或算法文档已按需更新；
- diff 中没有密钥、个人信息、构建产物或无关格式化；
- 第三方数据、代码和素材的许可证允许本项目使用，并已补充必要署名。

提交贡献即表示你有权提供这些改动，并同意它们按本项目的 [MIT License](LICENSE) 发布。本项目目前不要求签署 CLA。
