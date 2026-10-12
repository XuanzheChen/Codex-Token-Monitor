# Codex Token Monitor

语言：[EN](./README.md)

Codex Token Monitor 是一个用于实时监控、费用估算和可视化 Codex token 使用情况的 VS Code 扩展。

## 项目目的

这个项目的目标，**是让 Codex 使用过程中的 token 消耗变得实时可见**。AI 使用中有一个很容易被误解的原则：**并不是给模型喂得越多，模型就一定越聪明**。很多时候反而是反直觉的——**上下文太多会引入噪声，导致准确率下降，同时还会显著增加 token 消耗**。

因此，我希望能够实时了解每段对话的 token 用量、输入 token、缓存命中率和费用估算。这样可以帮助我更有意识地组织问题，在提高回答准确度的同时，减少本就不多的额度消耗。

单纯依赖 Codex 官方显示的额度百分比，对这个目标来说还不够细。[ccusage](https://github.com/ryoppippi/ccusage) 项目给了我启发：原来可以通过读取本地 Codex JSONL session 文件，直接拿到 token 消耗量。但 ccusage 不能在 VS Code 中实时检测每一条 token 事件的用量，所以我开发了这个插件。希望通过 token 的实时反馈，提高提问效率，让每一次上下文输入都更克制、更有效。

Codex Token Monitor 会监视你的 Codex JSONL 会话文件，读取 `event_msg` 中 `payload type` 为 `token_count` 的事件，并把最新 token 用量直接显示在 VS Code 状态栏中。

```text
18:41  +56k(in 54.6k, cache 50k, 91%)  $0.12
```

状态栏会显示最新一轮 session 的 token 用量，包括总 token、输入 token、缓存命中 token、缓存命中百分比和本轮估算费用。

点击状态栏中的 token usage 项目，可以打开更详细的可视化仪表盘。

![Codex Token Usage Dashboard](docs/dashboard.gif)

## 功能

- 默认监视 `~/.codex/sessions`。
- 支持嵌套的 Codex 会话目录，例如 `sessions/2026/04/30/*.jsonl`。
- 在 VS Code 状态栏中显示最新一轮 session 的总 token、输入 token、缓存命中 token、缓存命中百分比和估算费用。
- 使用与 ccusage 兼容的统计方式：把每个 `token_count` 事件视为累计值，并通过同一会话文件中连续累计值之间的正向差值计算用量。
- 避免重复统计重复出现的 `token_count` 事件，因为重复的累计值会产生 0 增量。
- 根据 Codex session 日志中解析到的实际模型 ID 估算费用，分别计算非缓存输入、缓存输入、输出和 fast mode 费用。
- 可以从状态栏打开可视化仪表盘，包含今日时间线、7 日用量、30 日用量、最近会话、详细事件记录和模型费用明细。
- 支持账号筛选。你可以通过把不同账号标签映射到不同的 Codex 会话目录来配置多个账号。
- Today Timeline 上的点会在悬停时和 Today Events 表格中的对应行联动。
- 在 Today Timeline 上绘制空心的 prompt/session 圆环，并将它们与 Recent Sessions 表格联动。
- Today Events 和 Recent Sessions 中会显示每行费用，鼠标悬停费用时可以查看计算过程。
- 提供刷新数据、打开最近会话、显示详情和选择自定义会话目录等命令。

## 安装

### 方式 1：从 VS Code Marketplace 安装

1. 打开 VS Code。
2. 打开扩展视图。
3. 搜索 `Codex Token Monitor`。
4. 点击 **Install**。

### 方式 2：从 VSIX 安装

1. 下载最新的 `.vsix` 文件。
2. 打开 VS Code。
3. 打开扩展视图。
4. 点击扩展面板右上角的三点菜单。
5. 选择 **Install from VSIX...**。
6. 选择已下载的 `.vsix` 文件完成安装。

## 使用方法

安装后，Codex Token Monitor 会自动监视你的 Codex sessions 文件夹，并在 VS Code 状态栏显示 token 用量。

点击状态栏项可以打开详细仪表盘。仪表盘会展示今日时间线、最近事件、最近会话、模型费用表，以及最近 7 天和 30 天的使用趋势。

费用会根据 Codex session 中解析到的模型名称计算。无法识别价格的模型会显示为未计价，不会静默套用 fallback 模型价格。

当前内置价格表包含：

- `gpt-5.5`
- `gpt-5-codex`
- `gpt-5.1-codex`
- `gpt-5.1-codex-max`
- `gpt-5.2-codex`
- `gpt-5.3-codex`

## 命令

- `Codex Token Monitor: Refresh`
- `Codex Token Monitor: Open Latest Session`
- `Codex Token Monitor: Choose Sessions Folder`
- `Codex Token Monitor: Show Details`

## 设置

- `codexTokenMonitor.sessionsRoot`：自定义 Codex sessions 文件夹。留空时使用默认的 `~/.codex/sessions`。
- `codexTokenMonitor.accounts`：可选账号列表，用于对比多个 Codex sessions 文件夹。
- `codexTokenMonitor.refreshIntervalMs`：备用轮询间隔。默认是 `1000`。

多账号配置示例：

```json
"codexTokenMonitor.accounts": [
  {
    "label": "Work",
    "sessionsRoot": "C:\\Users\\PC\\.codex-work\\sessions"
  },
  {
    "label": "Personal",
    "sessionsRoot": "C:\\Users\\PC\\.codex\\sessions"
  }
]
```

## 本地开发

在 VS Code 中打开这个文件夹，然后按 `F5` 启动 Extension Development Host。

运行语法检查：

```powershell
npm.cmd run check
```

在不安装 `vsce` 的情况下生成本地 VSIX：

```powershell
npm.cmd run package
```

生成的 VSIX 会输出到 `dist/` 目录。

## 许可证

本项目采用 [MIT License](./LICENSE)。


## 自维护版本 v0.4.0

本 Fork 使用独立扩展 ID `XuanzheChen.codex-token-usage`，保留 `codexTokenMonitor.*` 配置键，便于从旧版迁移。安装前请禁用或卸载原版以免出现两个状态栏。

自动汇总 `<CODEX_HOME>/sessions` 和同级的 `archived_sessions`；默认优先读取 VS Code 进程的 `CODEX_HOME` 环境变量，没有则使用 `~/.codex`。同名 rollout 日志去重，归档不再使历史统计消失。多账户配置 `codexTokenMonitor.accounts` 仍可用。

自定义价格示例（单价为美元 / 100 万 Token）：

```json
{
  "codexTokenMonitor.sessionsRoot": "E:/codexzh/sessions",
  "codexTokenMonitor.modelPrices": {
    "gpt-6-sol": {"input": 2, "cached": 0.2, "output": 10},
    "gpt-6.1-sol": {"input": 2, "cached": 0.1, "output": 10},
    "gpt-6-astra": {"input": 10, "cached": 1, "output": 50}
  },
  "codexTokenMonitor.priceMultiplier": 1.25,
  "codexTokenMonitor.currencySymbol": "$",
  "codexTokenMonitor.currencyRate": 1
}
```

只显示人民币时，可以设置 `currencySymbol: "¥"`，并将 `currencyRate` 设置为你的**实际**美元到人民币兑换比例。换算不改变底层美元计价。未知模型或混入未知模型的汇总费用显示 `N/A`，而不是虚假的 `$0.00`。更改配置将重新扫描日志并计算历史费用。可在 GitHub Actions 的成功构建中下载 VSIX artifact。

旧版若已经在 `codexTokenMonitor.accounts` 中把 `sessions` 和 `archived_sessions` 配置为两个账户，新版会跨账户去重；更推荐删除归档账户配置，只保留 `sessions` 作为一个账户根目录，以免账户选择器产生无用的空项。


## v0.5.0：图表和真实会话

- Last 7 Days 与 Last 30 Days 合并为一张可通过标题下拉切换的图；输入和输出使用独立刻度，悬停显示输入（含缓存）、输出及两者分别的费用（包括中转倍率和币种汇率）。两个刻度独立，**柱高不可直接比较两者绝对 Token 数**。
- Recent Sessions 按真实 Codex rollout JSONL 会话汇总，不再按用户每条消息产生伪 Session；新增 Turns 列。Today Timeline 仍保留细粒度 Prompt Turn 标记，状态栏继续显示最新一轮 Token。
- 未知模型的价格仍显示 N/A，避免将不完整费用当成完整金额。


## v0.5.1：状态栏 Session 口径修复

- VS Code 右下角状态栏和悬浮提示的 Session total、Input、Cache、Output、Session cost 现在都使用同一个 **rollout JSONL 会话累计值**，不再误用最近一轮用户输入的 `latestTurnGroup`。
- 悬浮提示中的最新一轮用量与费用单独标明 **Latest turn**，便于分清会话累计与最近一轮。
- 多模型、多 effort 的会话费用为该 Session 内所有计费用量的汇总。计费单价、缓存和倍率设置保持不变。


## v0.6.0：可读坐标轴与统计概览

- 7/30 天图增加可读的左、右双纵轴，每侧分别显示 0、25%、50%、75%、100% 所对应的 Token 值。独立刻度并不意味着两边柱高可以直接比较绝对数量。
- Today 与 Cache 合并为同一张卡；Today、7 Days、30 Days 均显示 Token 总量、缓存 Token、费用、输入/输出，以及 **缓存命中率** = 缓存输入 / 总输入，**输出/输入比** = 输出 / 总输入。
- Sessions 卡片分为 Today、7 Days、30 Days、Total 四项。Today / 7 Days / 30 Days 表示该时间范围内发生过 Token 事件的**不同 rollout 会话文件数**；Total 是扫描到的所有去重后的 JSONL 文件数（含归档，不受 30 天限制），包括没有 Token 事件的文件。一个会话跨多天活跃时可以计入多个时间范围，但每个范围内部只算一次。跨账户先去重后合并。
- Today Timeline 保持不变，等待后续需求决策。
