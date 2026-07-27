<div align="center">

# LoadToAgent

### 在一个本地控制台中查看所有正在工作的 AI

监控 Claude、Codex、Gemini 和 Grok 会话，追踪主代理与子代理的关系，检查 Token 用量，并把任务直接发送到已连接的终端。对话记录不会上传到外部服务。

[![Desktop CI](https://github.com/minjund/LodeToAgent/actions/workflows/desktop-ci.yml/badge.svg)](https://github.com/minjund/LodeToAgent/actions/workflows/desktop-ci.yml)
[![npm version](https://img.shields.io/npm/v/loadtoagent?logo=npm&color=CB3837)](https://www.npmjs.com/package/loadtoagent)
[![GitHub Release](https://img.shields.io/github/v/release/minjund/LodeToAgent?display_name=tag&sort=semver)](https://github.com/minjund/LodeToAgent/releases/latest)
![macOS](https://img.shields.io/badge/macOS-支持-111827?logo=apple)
![Windows](https://img.shields.io/badge/Windows-支持-111827?logo=windows11)
![Local first](https://img.shields.io/badge/数据-本地优先-35d69f)

[English](README.md) | **简体中文** | [한국어](README.ko.md)

[**下载 Windows / macOS 程序**](https://github.com/minjund/LodeToAgent/releases/latest) · [**通过 npm 安装**](https://www.npmjs.com/package/loadtoagent)

</div>

<div align="center">
  <img src="docs/assets/loadtoagent-demo.gif" alt="LoadToAgent 演示：查看 AI 任务、子代理、对话和 Token 用量" width="960" />
</div>

> AI 会话记录始终保留在你的电脑上。LoadToAgent 只读取你已经在使用的 AI 工具生成的本地会话文件。

## 安装与运行

你可以使用 npm，也可以直接下载可运行的桌面文件。两种方式都不需要通过 Git 下载仓库。

### 方式一：npm

LoadToAgent 已在 npm 以 [`loadtoagent`](https://www.npmjs.com/package/loadtoagent) 发布。全局安装后，运行 `loadtoagent` 命令即可打开桌面应用：

```bash
npm install -g loadtoagent
loadtoagent
```

npm 安装方式不会创建桌面或应用程序快捷方式。每次需要打开应用时，请在终端运行 `loadtoagent`。如果安装后终端暂时找不到该命令，请关闭并重新打开终端。

```bash
# 更新
npm install -g loadtoagent@latest

# 卸载
npm uninstall -g loadtoagent
```

### 方式二：直接下载桌面文件

打开[最新 GitHub Release](https://github.com/minjund/LodeToAgent/releases/latest)，下载与你的电脑匹配的文件。此方式不需要 Node.js。

| 系统 | 下载文件 | 启动方式 |
|---|---|---|
| Windows 10/11 (x64) | `LoadToAgent-Setup-<version>.exe` | 推荐用于首次安装和应用内更新。 |
| Windows 10/11 (x64) | `LoadToAgent-<version>-portable.exe` | 双击下载的文件。它是无需安装的便携版程序。 |
| Apple 芯片 Mac | `LoadToAgent-<version>-arm64.dmg` | 打开 DMG，将 LoadToAgent 拖入“应用程序”，然后从“应用程序”中打开。 |
| Intel Mac | `LoadToAgent-<version>-x64.dmg` | 打开 DMG，将 LoadToAgent 拖入“应用程序”，然后从“应用程序”中打开。 |

当前桌面文件尚未进行代码签名，因此 Windows SmartScreen 或 macOS Gatekeeper 可能显示未知开发者警告。只有在文件来自本仓库官方 Releases 页面时才继续。macOS 用户可按住 Control 键点按 LoadToAgent，然后选择**打开**；Windows 用户可选择**更多信息 → 仍要运行**。

### 在应用内更新

LoadToAgent 启动时会比较当前包版本与最新的稳定 GitHub Release 标签。如果存在更高版本，应用顶部以及**设置 → 程序更新**中会显示提示。应用会下载对应的 Windows Setup EXE 或 macOS DMG，并校验 GitHub 提供的文件大小和 SHA-256（如有），随后可直接打开安装文件。npm 安装仍可使用 `npm install -g loadtoagent@latest` 更新。

### 环境要求

- macOS 或 Windows
- 仅通过 npm 安装时需要 Node.js 18 或更高版本
- 至少安装并登录一个 CLI：Claude Code、Codex CLI、Gemini CLI 或 Grok CLI
- macOS 持久 AI 会话或 Windows WSL 托管会话需要 tmux。Windows 原生 AI 会话和普通命令行仍使用直接 PTY 后端。

## 前 10 分钟上手

1. 在**首页**点击`新建 AI 任务`，填写目标并选择工作目录。如果尚未安装受支持的 AI，请先按照应用中显示的官方安装链接完成设置。
2. 打开**进行中**，查看所有绿色状态的 AI。只有需要检查子代理分工时，再展开`查看详细流程`。
3. 当**需要你确认**出现数字时，优先处理需要回复或选择的任务。
4. 打开任务卡片，查看**对话、进度和用量**；对于已连接的任务，可在**会话终端**中继续输入。

首页的`10 分钟入门指南`可以带你实际完成同样的四个步骤。进度只保存在本机，并且可随时重新打开。

### 继续对话并确认实际传递状态

打开任务的**对话**页，使用**继续对话**即可向受支持的已连接会话发送新消息。消息会保留在同一个任务和 AI 会话中，不会另开聊天。

LoadToAgent 会按照实际可观测证据显示三个传递步骤：

1. 应用是否已发出发送请求；
2. 相同的用户消息是否已出现在 AI 会话记录中；
3. 该消息之后是否出现了新的 AI 回复开始信号。

如果 12 秒内仍未在会话记录中确认收到消息，应用会显示“传递确认延迟”，而不会直接声称 AI 正在准备回复。AI 的中间进度消息也会按时间顺序保留在对话中，不再放入单独的折叠区域；只有最后一条已完成消息会标记为**最终回答**。所有状态文字都说明本地会话文件中的可验证证据，不会猜测外部 AI 窗口正在做什么。

## LoadToAgent 可以展示什么

| 视图 | 内容 |
|---|---|
| 代理地图 | 按 Claude、Codex、Gemini 和 Grok 分组的实时任务 |
| 关系视图 | 用户请求、当前代理以及它直接委派的所有子代理 |
| 执行单元 | AI 启动的前台 Shell、后台 Shell 与后台任务，包括命令、工作目录、执行 ID 和实时状态 |
| 运行概览与待确认收件箱 | 按优先级集中展示失败、停滞、上下文风险、审批、决策和输入请求，并可立即处理 |
| 会话详情 | 按时间排列的对话、基于证据的传递状态、工具活动、执行过程、模型、工作目录和状态 |
| 管理摘要 | 检查点、观测置信度、完成摘要、产物、验证结果和执行控制 |
| Token 视图 | 输入、输出、缓存、推理、总量和已报告的上下文占用率 |
| 终端控制 | 本地 Shell，以及向 LoadToAgent 自有终端安全发送命令 |
| tmux 工作区 | macOS 或 Windows WSL 中的会话 → 窗口 → 面板 → AI 进程拓扑 |

计划与循环、会话终端和 tmux 工作区统一收纳在左侧的**高级工具**中，让日常监控流程保持聚焦。

LoadToAgent 会区分可直接控制的终端、需要桥接的会话、必须回到原应用继续的只读会话以及已结束会话。它不会向任意外部窗口注入键盘输入。

## 使用已连接的终端

保持 LoadToAgent 桌面应用运行，然后通过经过认证的本地桥接启动 AI CLI：

```bash
loadtoagent run claude
loadtoagent run codex
loadtoagent run gemini
loadtoagent run grok
```

`--` 后面的参数会原样传给对应的 AI CLI：

```bash
loadtoagent run claude -- --model claude-sonnet-4-6
```

外部终端与 LoadToAgent 仪表盘会共同控制同一个 LoadToAgent 专用会话。在 AI 卡片中打开终端时，会复用准确的现有终端和会话 ID，不会创建新的 Shell；切换页面时输出也会保留。在其他地方启动的现有会话仍然可见，但除非原应用提供受支持的交接方式，否则会保持只读。

macOS 和 WSL 的持久 AI 终端运行在隔离的 `tmux -L loadtoagent` 服务器中，不会混入个人 tmux。`关闭终端视图`只会分离当前 attach 画面，AI 工作仍在后台继续。`重新连接现有工作`会连接到相同的 tmux 会话和 LoadToAgent 会话 ID，不会创建新的 AI 对话。`结束 AI 会话`会停止实际 tmux 工作但保留记录，随后可以单独移除已停止的记录。

即使仪表盘或终端主机意外退出，只要 tmux 工作仍然存在，下次启动就会恢复同一个会话。若保存的 tmux 会话已经消失，LoadToAgent 会将记录标记为已停止，而不会静默创建重复的 AI 对话。Windows 原生 AI 会话和普通命令行继续使用直接 PTY/终端主机方式。运行中、已分离、自然退出或启动失败的记录都会保留到用户明确移除为止。

## 本地优先与安全

- 会话文件直接从用户目录读取。
- 不读取或显示 API Key 文件；认证由各个 AI CLI 自行处理。
- 终端桥接使用每位用户独立的令牌，以及本地 named pipe 或 Unix domain socket。
- 执行终端或 tmux 操作前，会验证请求来源、目标和输入格式。
- 开启工作目录写入权限后，所选 AI 可以修改该目录，因此请只在可信仓库中启用。

共享屏幕前请检查当前显示的会话内容，因为 AI 对话和工具输入可能包含敏感的项目信息。

## 本地开发

```bash
npm install
npm start
npm test
```

其他检查与发行构建：

```bash
npm run test:terminal
npm run test:terminal:managed
npm run test:bridge
npm run test:tmux -- macOS
npm run test:visual
npm run dist:mac
npm run dist:win
```

`dist:mac` 会生成 Apple Silicon 和 Intel 的 DMG/ZIP 文件；`dist:win` 会生成 Windows Setup 和便携版可执行文件。正式的 macOS 发行仍需要维护者提供 Apple 签名与 notarization 凭据。

## 支持的会话来源

| AI | 现有会话 | 新任务流 | 子代理 |
|---|---|---|---|
| Claude | Claude Code 本地 JSONL 记录 | 结构化 headless 输出 | transcript 中的 subagent 记录 |
| Codex | Codex 本地 rollout JSONL | `codex exec --json` | `thread_spawn` 父级元数据 |
| Gemini | Gemini 本地 chat JSON/JSONL | 结构化流式输出 | 工具提供时使用父级 ID |
| Grok | Grok 本地 session JSON/JSONL | 结构化流式输出 | 工具提供时使用父级 ID |

各提供商的事件映射与上下文计算规则记录在 [Provider Contracts](docs/PROVIDER-CONTRACTS.md) 中。

## 安全与本地数据

渲染进程在沙箱中运行，发行安装包必须经过代码签名。应用内更新同时验证 SHA-256 digest 和平台签名。已完成的托管任务与终端历史默认在 30 天后过期。详情请参阅[安全政策](SECURITY.md)、[威胁模型](docs/THREAT-MODEL.md)和[数据保留政策](docs/DATA-RETENTION.md)。

## 发布

将 `v*` Git 标签推送到远程仓库后，工作流会先验证版本、构建并检查已签名的桌面文件、上传私有草稿，再按配置发布带来源证明的 npm 包，最后公开 GitHub Release。`package.json` 版本必须与标签一致；缺少代码签名或 notarization 密钥时发布会失败。

维护者所需凭据和发布门禁记录在 [Releasing](docs/RELEASING.md) 中。

```bash
npm version patch --no-git-tag-version
git add package.json package-lock.json
VERSION=$(node -p 'require("./package.json").version')
git commit -m "release: v$VERSION"
git tag "v$VERSION"
git push origin HEAD --follow-tags
```

## 许可证

LoadToAgent 采用 [MIT 许可证](LICENSE)发布。

---

<div align="center">
  为同时运行多个 AI、又想准确了解每一个 AI 在做什么的人而设计。
</div>
