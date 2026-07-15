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
- 只有使用 tmux 工作区地图时才需要安装 tmux

## 前 10 分钟上手

1. 在**首页**点击`新建 AI 任务`，填写目标并选择工作目录。如果尚未安装受支持的 AI，请先按照应用中显示的官方安装链接完成设置。
2. 打开**进行中**，查看所有绿色状态的 AI。只有需要检查子代理分工时，再展开`查看详细流程`。
3. 当**需要你确认**出现数字时，优先处理需要回复或选择的任务。
4. 打开任务卡片，查看**对话、进度和用量**；对于已连接的任务，可在**会话终端**中继续输入。

首页的`10 分钟入门指南`可以带你实际完成同样的四个步骤。进度只保存在本机，并且可随时重新打开。

## LoadToAgent 可以展示什么

| 视图 | 内容 |
|---|---|
| 代理地图 | 按 Claude、Codex、Gemini 和 Grok 分组的实时任务 |
| 关系视图 | 用户请求、当前代理以及它直接委派的所有子代理 |
| 会话详情 | 对话、工具活动、执行过程、模型、工作目录和状态 |
| Token 视图 | 输入、输出、缓存、推理、总量和已报告的上下文占用率 |
| 终端控制 | 本地 Shell，以及向 LoadToAgent 自有终端安全发送命令 |
| tmux 工作区 | macOS 或 Windows WSL 中的会话 → 窗口 → 面板 → AI 进程拓扑 |

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

外部终端与 LoadToAgent 仪表盘会共同控制同一个 LoadToAgent 专用 PTY。在其他地方启动的现有会话仍然可见，但除非原应用提供受支持的交接方式，否则会保持只读。

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

## 发布

将 `v*` Git 标签推送到远程仓库后，工作流会运行完整测试、发布带来源证明的 npm 包、构建 macOS 与 Windows 文件，并自动创建附带这些文件的 GitHub Release。`package.json` 版本必须与标签一致。

```bash
npm version patch --no-git-tag-version
git add package.json package-lock.json
VERSION=$(node -p 'require("./package.json").version')
git commit -m "release: v$VERSION"
git tag "v$VERSION"
git push origin HEAD --follow-tags
```

---

<div align="center">
  为同时运行多个 AI、又想准确了解每一个 AI 在做什么的人而设计。
</div>
