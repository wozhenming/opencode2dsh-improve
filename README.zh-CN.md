<div align="center">

# opencode2dsh-improve

**在 DSH（DeepSeek Harness）里原生使用 OpenCode Zen 的免费匿名模型。**

无需 API Key。无需注册。免费通道由一个受管理的本地运行时驱动。

[![license](https://img.shields.io/badge/license-MIT-blue)](https://github.com/wozhenming/opencode2dsh-improve/blob/main/LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](https://nodejs.org)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-blue)](https://github.com/wozhenming/opencode2dsh-improve)

[English](README.md) | 简体中文

</div>

---

opencode2dsh 会向 DSH 注册一个原生的 `LlmAdapter`，直接流式对接
[OpenCode Zen](https://opencode.ai/zen) 的**匿名免费通道**——也就是
OpenCode 官方 CLI 无需登录即可使用的那批免费模型，它们会以 `opencode2dsh`
这个常规 provider 出现在你的 DSH 模型选择器里。

插件发出的请求与 OpenCode CLI 的流量完全同形（相同的 User-Agent、相同的
关联请求头），模型目录通过三级回退链保持新鲜。不用登录任何账号，也不用
自己部署任何东西。

## 本仓库的改进：委托运行时 + 真实流式

本仓库（`wozhenming/opencode2dsh-improve`）是
[opencode2dsh](https://github.com/FishBottle7/opencode2dsh) 的改进分支：
在上游免费通道开始拒绝一切非真正 OpenCode 运行时的请求
（`403 FreeTierError`）之后让插件继续可用，并把真实流式——包括模型的
思考过程——补了回来。

```
DSH 会话 → ZenAdapter → 回环 shim → 隔离的 `opencode serve` → Zen 免费模型
```

**相对上游的改进**

- **用"委托真实运行时"修复 403**——在独立 XDG 数据目录
  （`~/.opencode2dsh/delegate`）里管理一个官方 `opencode serve`
  （`opencode-ai` 二进制，带版本校验，自动发现或下载），再通过回环
  OpenAI 兼容 shim 接回原有 adapter。Zen 侧看到的是真正的 OpenCode 流量，
  免费模型因此恢复可用。该通道还会：注入本机 Zen 凭据（若存在）、吸收全新
  数据目录首次推理必吃的一次性拒绝（预热 + 重启运行时一次）、限制运行时
  内存（`GOMEMLIMIT=96MiB`、`GOGC=30`）并修剪 Windows 工作集。
  默认开启；`delegate: false` 可回到直连通道。
- **真实流式输出，思考过程可见**——上游整轮缓冲、只在结束时一次性吐出最终
  文本。本分支实时转发运行时的事件流：思考增量变成 `reasoning_content`
  （DSH 会渲染实时思考块），答案在模型书写 JSON 信封的过程中增量提取并即时
  输出；工具调用仍然只在完成校验后发出。纠正重试会在同一条流上续写，运行时
  回显的用户消息文本会被过滤，不会混入回答。

**依赖的项目**

| 项目 | 在本仓库中的角色 | 许可证 |
| --- | --- | --- |
| [FishBottle7/opencode2dsh](https://github.com/FishBottle7/opencode2dsh) | 本仓库 fork 的上游插件（adapter、目录、伪装） | MIT © FishBottle7 |
| [XDTrees/dsh-opencode-xdbridge](https://github.com/XDTrees/dsh-opencode-xdbridge) | `lib/delegate/` 下 vendored 的运行时/shim/协议核心，见 `lib/delegate/LICENSE-xdbridge` | MIT © XDTrees |
| [OpenCode](https://opencode.ai)（`opencode-ai`） | 委托通道驱动的真实运行时 | MIT |
| [@earendil-works/pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai) | adapter 使用的线上协议层 | MIT © Mario Zechner |
| [opencode2api](https://github.com/jasonxu114514/opencode2api) | 上游匿名通道的目录与伪装细节来源 | — |
| [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) · [dsh-market](https://github.com/dsh-market/dsh-market) | 宿主平台与插件市场 | — |

**从本分支安装**——在 DSH 打开 **设置 → 插件**，安装框输入
`github:wozhenming/opencode2dsh-improve`（或
`https://github.com/wozhenming/opencode2dsh-improve`）；也可固定提交：
`github:wozhenming/opencode2dsh-improve#<sha>`。安装后的包名与插件页条目为
`opencode2dsh-improve`；模型选择器里的 provider 仍是 `opencode2dsh`（除非
改写 `providerId`）。请先卸载上游 `@opencode2dsh/dsh-plugin`——两份同时
安装会冲突（同一 provider 路由与委托运行时）。

## 特性

- **零凭据、零配置**——匿名通道不需要任何 Key；装好、重启、开聊
- **原生 adapter，无 sidecar**——一个 npm 包，没有子进程、没有二进制、没有本地端口（旧版 Go sidecar 不随包发行，见 `legacy/`）。本分支默认通道会管理一个隔离的 `opencode serve`（见上文），`delegate: false` 可回到上游直连通道。
- **CLI 同形伪装**——请求携带 OpenCode CLI 的 User-Agent 和整套会话/请求/项目关联头，按会话派生
- **思考等级可选**——带推理的免费模型在 DSH 模型选择器里出现思考等级选项（模型声明档位的按声明展示，其余提供 Off/Minimal/Low/Medium/High）；Off 向上游发送 `reasoning_effort: "none"` 真正停思考，不选则保持上游默认
- **按声明支持图片输入**——只要 [models.dev](https://models.dev) 的模型条目在 `modalities.input` 里列了 `image`，图片附件就会被放行；只声明 `text` 的模型仍然拒绝；元数据缺省时退回已验证的视觉家族
- **实时目录 + 三级回退**——上游实时列表 ∩ 元数据判定免费，断网时依次回退到磁盘缓存与已验证的静态名单
- **自愈能力**——启动期快速重试、周期刷新，并落盘健康快照便于排查
- **规范的错误呈现**——上游故障（限流、鉴权、超时、传输）以分类的 finish 原因送达 DSH，重试策略始终由 DSH 掌控

## 安装

**从本仓库安装（本分支推荐）**——在 DSH 打开 **设置 → 插件**，安装框输入
`github:wozhenming/opencode2dsh-improve`（或
`https://github.com/wozhenming/opencode2dsh-improve`）；终端里也可以：

```sh
dsh plugin --profile web add github:wozhenming/opencode2dsh-improve
```

无需构建：本仓库直接携带构建好的 `lib/`，没有 `prepare` 脚本，git 安装
原样使用。安装后的包名是 `opencode2dsh-improve`；插件页条目与模型分组名
的关系见上文"本仓库的改进"。

**上游发行版（npm）**——`dsh plugin --profile web add
@opencode2dsh/dsh-plugin` 装的是 FishBottle7 的发行版，不是本分支；插件
市场里的 `opencode2dsh` 条目就是那个上游版本，不含委托通道与实时流式。

**验证**：重启 DSH，打开模型选择器，在 **opencode2dsh** 分组里选模型即可
（本分支不改 provider id）。

需要 DSH（DeepSeek Harness）0.1.7 及以上、带 web profile（IP 池设置页依赖 0.1.7
的插件页契约）；Node.js ≥ 20（DSH 能跑就满足）；出站 HTTPS 需可达 `opencode.ai`
与 `models.dev`；委托通道首次运行还需可达 `registry.npmjs.org` 或 `github.com`，
用于下载并校验受管的 `opencode` 运行时（缓存在 `~/.opencode2dsh/delegate`，
之后复用）。

## 首次启动（通过 GitHub 链接安装）

新机器上**第一条消息发出去时，委托运行时通常还没就绪**：它要先下载约 60 MB 的
`opencode` 运行时（支持断点续传，重启继续），再拉起服务、读取免费模型清单；
数据目录全新时还会预热一次（Zen 对新目录的首次推理必定拒绝一次，插件会自动
重启运行时重试）。

- 运行时没就绪时，请求会得到一条明确提示而不是"请求超时"：
  `委托运行时仍在准备（正在下载 OpenCode：12.3 / 60.2 MB）……请稍后重试`，
  或者 `委托运行时准备失败：<原因>`。等日志出现
  `delegated OpenCode runtime ready` 后重发即可。
- **看不到原因就直接看页面**：**设置 → 插件 → opencode2dsh → 日志**，里面有
  插件自身的日志、委托运行时的当前状态（准备中/失败原因），以及运行时日志
  文件的尾部（下载进度、预热、被拒记录），支持刷新、自动刷新和一键复制，
  把那段内容发给插件作者即可定位。
- 想让第一条消息直接等更久：配置 `delegateStartWaitMs`（毫秒，默认 `90000`，
  范围 `1000`–`600000`）。
- 下载慢或被限流时，把 `HTTPS_PROXY`（或 `HTTP_PROXY`）设置成 **DSH 进程能读到**
  的环境变量——插件自己读这些变量做隧道，但 GUI 启动的 DSH 不继承系统代理设置。
- 完全无法访问外网源时，用 `OPENCODE_XDBRIDGE_RUNTIME_URL=<本地 tgz 或内网镜像>`
  指向一个本地运行时包（跳过探测）。
- 内存较小的机器可用 `OPENCODE2DSH_GOMEMLIMIT=192MiB` 放宽运行时的堆上限
  （默认 `96MiB`）。

## 配置

默认配置开箱即用。需要覆盖时，编辑 profile 的 `cordis.patch.yml`：

```yaml
- id: opencode2dsh-improve
  name: 'opencode2dsh-improve'
  config:
    mode: adapter        # adapter（默认）| sidecar
    providerId: opencode2dsh
    refreshSeconds: 300  # 目录刷新周期（秒）
```

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `mode` | `adapter` | `adapter`：原生 LlmAdapter 直连 Zen。`sidecar`：旧版本地 agent 模式，不随包发行——请从 `legacy/agent` 自行构建并通过 `agentPath` 指定。 |
| `providerId` | `opencode2dsh` | 在 DSH 中显示的 provider 名称。 |
| `refreshSeconds` | `300` | 实时目录刷新间隔；定价元数据每 24 小时刷新。 |
| `agentPath` | 自动解析 | 仅 sidecar：agent 二进制路径。 |
| `agentArgs` | — | 仅 sidecar：传给 agent 的额外 CLI 参数。 |
| `restartDelayMs` / `restartMaxDelayMs` / `maxConsecutiveCrashes` | `1000` / `60000` / `5` | 仅 sidecar：重启退避与熔断阈值。 |
| `firstEventMs` / `bodyIdleMs` / `responsesBodyIdleMs` | `30000` / `120000` / `300000` | 仅 adapter，插件 0.3.7 起支持：流存活超时，单位毫秒，取 `1` 到 `600000` 的整数。分别控制首事件等待、流中静默，以及 Responses 模型（`muse-spark-*`）的静默下限。冷启动慢时可调大 `firstEventMs`。不设置则使用默认值；修改后重启 DSH。 |
| `delegate` | `true` | 仅本分支：使用受管理的隔离 OpenCode 运行时（即免费通道 403 的修复），而不是上游直连通道。 |
| `delegateStartWaitMs` | `90000` | 仅本分支：单个请求等待受管运行时就绪的时长（`1000`–`600000`）。仍在下载/预热时，请求会带上运行时当前状态明确报错，而不是笼统的超时。 |
| `delegateDataDir` | `~/.opencode2dsh/delegate` | 仅本分支：受管运行时、shim 与日志的数据目录。 |
| `delegateBinaryPath` / `delegateRuntimeVersion` | 自动解析 / 最新已知 | 仅本分支：指定 `opencode` 二进制，或固定运行时版本。 |

## 工作原理

```
DSH 会话
   │  harness chunk（block-start / text-delta / usage / finish …）
   ▼
ZenAdapter（注册的 LlmAdapter）
   │  pi-ai openai-completions 流式
   ▼
https://opencode.ai/zen/v1        ← Authorization: Bearer public
   携带与 CLI 同形的请求头：
     user-agent: opencode/…
     x-opencode-client, x-opencode-session, x-session-affinity,
     X-Session-Id, x-opencode-request, x-opencode-project
```

- **会话关联**——session/project id 由会话首条用户消息经 SHA-256 派生
  （同一会话稳定、不可逆推），每个请求再附带一个全新的随机 id，与 CLI 行为一致。
- **目录回退链**——S1：实时 `GET /v1/models`；S2：models.dev 定价元数据判定
  "免费"；S3：编译期验证的静态名单。上游故障时由磁盘缓存（约 7 天有效期）兜底。
- **韧性**——adapter 在启动时立即注册；若首次目录拉取撞上网络尚未就绪
  （VPN/TUN 重连、DNS 等），会以短周期重试（约 1 分钟内），随后转入常规刷新。
- **sidecar 模式**（`mode: sidecar`，旧版）——拉起本地 Go agent（
  [opencode2api](https://github.com/jasonxu114514/opencode2api) 的单租户移植版），
  监听 `127.0.0.1:<随机端口>`、token 鉴权，并注册标准 `llm-pi-ai` 路由。
  **不随包发行**；请从 `legacy/agent` 构建（`go build ./cmd/agent`）并把
  `agentPath` 指向产物。

## 健康状态与排查

插件在每轮刷新后写入健康快照：

```
~/.opencode2dsh/adapter-status.json
```

```json
{
  "status": "ready",
  "total": 64,
  "exposed": 9,
  "lastError": "",
  "writtenAt": "2026-08-29T07:01:54.915Z"
}
```

| 现象 | 可能原因与处理 |
| --- | --- |
| `403 FreeTierError` / "OpenCode's free tier can only be used from within OpenCode" | 上游只允许真正的 OpenCode 运行时使用免费通道。**本分支默认已修复**：委托通道运行真实的隔离 `opencode serve`，该报错不应再出现。若仍出现，查看 `~/.opencode2dsh/delegate/opencode.log`；设置 `delegate: false` 时适用上游说明（请使用上游支持的 OpenCode 客户端或正式 API 服务）。 |
| 启动页报 `Failed to load plugins … list slot "plugins.item" requires options.id`，或 IP 池条目没有配置页 | DSH 早于 0.1.7 的插件页契约。升级 DSH 到 0.1.7（推荐最新）；页面挂载门控是 `configForms.whileServed`，0.1.6 及更早上整页不出现，模型路由不受影响。 |
| 安装插件后 DSH 0.1.7/0.2 无法启动，报 `pending … settingsScope` | 更新插件到 0.3.5；DSH 0.2 的 IP 池设置在插件页的 opencode2dsh-improve 条目里。 |
| 只有 3 个模型 | 启动时网络未就绪，重试会在约 1 分钟内补齐；看 `adapter-status.json` 里的 `lastError`。 |
| `lastError: "fetch failed"` 持续出现 | 出站 HTTPS 到 `opencode.ai` 被拦截；检查代理/VPN 规则。 |
| 对话中报限流错误（`429 … Endpoint is unavailable`） | 匿名通道按 IP 限额，免费模型竞争大。[#51](https://github.com/FishBottle7/opencode2dsh/issues/51) 修复后，插件的 provider 重试策略会静默扛过 429 突发（8 次重试、约 1s→20s 退避、每步最坏约 90s），不再直接抛给用户；仍被打满时可降低思考强度、换一个竞争较小的 `-free` 模型，或在插件设置页开启 IP 池（多出口轮换）。 |
| 思考耗尽输出预算，没有正文 | 插件 0.3.6 会在模型支持 Off 时关闭思考重试一次。已有任何正文或工具调用则不会重试。重试保持原输出上限，仍可能失败，两次请求的用量合并统计。不支持 Off 的模型（如 Muse）需要手动调整设置或更换模型。 |
| Muse 报 `REGION_BLOCKED` / "This model is not available in your country" | Zen 不向当前网络地区提供该模型。插件 0.3.5 保留上游解释；旧版会把这个 403 误报为 API 密钥无效。匿名通道不需要个人密钥，可使用当前地区可用的模型。 |
| 连接 `127.0.0.1:*` 报错 | 残留的 sidecar 路由遮蔽了 adapter；插件 ≥ 0.2.1 启动时会自动清理。 |
| 安装时报 `ERR_PNPM_IGNORED_BUILDS` | `pi-ai` 的传递依赖（`@google/genai`、`protobufjs`）带构建脚本，运行时并不需要。在插件市场里按提示选择允许/拒绝，或在 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds:` 下把这两项设为 `false`。 |

注：表中提到的版本号（`0.3.x`）指上游发行线；本分支基于上游 0.3.12
（清单版本 `0.4.0`），包含表中全部 0.3.x 修复，并叠加委托通道与实时流式。

## 安全性

- 不涉及任何机密：匿名通道的 Key 就是字面量 `public`；插件不存储任何东西，也没有任何遥测。
- 安装产物仅限 `lib/`；不执行任何依赖的构建脚本。
- 所有请求均从你的机器直连 `opencode.ai` / `models.dev`。

## 开发

本仓库只携带构建产物（`lib/`）——没有源码树、没有构建步骤，git 安装原样
使用 `lib/`。本分支的改动位于 `lib/delegate/`：委托通道（`index.js`、
`runtime.js`、`backend.js`、`shim.js`、`handoff.js`）与实时流式桥
（`stream.js`，以及 `backend.js`/`shim.js` 里的事件转发）。

源码开发——`pnpm typecheck`、`pnpm test`、`pnpm build`、`legacy/agent`
下的旧版 Go sidecar 以及移植文档——都在上游仓库：
[FishBottle7/opencode2dsh](https://github.com/FishBottle7/opencode2dsh)。

## 致谢

- [**opencode2api**](https://github.com/jasonxu114514/opencode2api)，作者
  [@jasonxu114514](https://github.com/jasonxu114514)——`legacy/agent` 里的旧版
  Go sidecar 是其匿名通道实现的移植版，目录回退链与请求伪装细节同样源自它。
  本项目能成立，全靠它踩过的路。
- [**dsh-opencode-xdbridge**](https://github.com/XDTrees/dsh-opencode-xdbridge)，作者
  [@XDTrees](https://github.com/XDTrees)——`lib/delegate/` 下 vendored 的委托
  运行时核心；本分支的 403 修复与实时流式工作建立在其之上（MIT）。
- [OpenCode](https://opencode.ai)——运营免费匿名 Zen 通道，并提供委托通道
  管理的官方运行时二进制。
- [@earendil-works/pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai)——adapter 模式使用的线上协议层。
- [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) 与
  [dsh-market](https://github.com/dsh-market/dsh-market) 社区。

## 友链

<div align="center">

**[LinuxDo](https://linux.do)** —— 新的理想型社区

</div>

## 许可证

[MIT](./LICENSE) © FishBottle7
