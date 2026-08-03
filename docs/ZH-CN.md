# 中文快速上手

本指南是 oh-my-cli 的简体中文快速上手入口，覆盖安装、模型配置（DashScope /
OpenAI 兼容端点）、CLI 与 Desktop 启动、会话与文件安全边界，以及常见故障排查。
英文文档为权威版本；本文与英文文档不一致时，以英文为准：

- [README.md](../README.md) — 完整功能与全部命令行选项
- [docs/FIRST-RUN.md](FIRST-RUN.md) — 从安装到第一个任务的验证路径
- [SECURITY.md](../SECURITY.md) — 安全政策
- [CONTRIBUTING.md](../CONTRIBUTING.md) — 贡献政策

## 这是什么

oh-my-cli 是一个小型代码智能体 CLI，提供文件与 shell 工具，基于 Node.js 22、
TypeScript 与 ESM 构建。它可以在交互终端中使用，也支持非交互自动化；同时提供
本地 Desktop 工作台（Electron），在同一个持久化会话体系上提供图形界面。

## 安装

需要 **Node.js 22 或更高版本**。在仓库根目录执行：

```bash
npm install
npm run build
```

`npm run build` 将 TypeScript 源码编译到 `dist/`，CLI 入口是 `dist/index.js`。
可以直接运行：

```bash
node dist/index.js --version
```

或者执行 `npm link`，之后即可使用 `oh-my-cli` 命令：

```bash
npm link
oh-my-cli --version
```

## 配置模型（DashScope / OpenAI 兼容端点）

oh-my-cli 与 OpenAI 兼容端点通信。阿里云百炼（DashScope）提供 OpenAI 兼容模式，
因此可以直接接入。配置有两种方式，环境变量的优先级始终高于配置文件。

### 方式一：环境变量

| 变量 | 是否必需 | 默认值 | 说明 |
|---|---|---|---|
| `OPENAI_API_KEY` | 是¹ | — | 服务商 API Key |
| `OPENAI_BASE_URL` | 否 | `https://api.openai.com/v1` | OpenAI 兼容端点地址 |
| `OPENAI_MODEL` | 是¹ | — | 模型名称 |

¹ 若通过下方配置文件提供，则无需在环境中导出。

DashScope 示例（请将凭据替换为你自己的 Key，切勿提交真实密钥）：

```bash
export OPENAI_BASE_URL="https://dashscope.aliyuncs.com/compatible-mode/v1"
export OPENAI_MODEL="<你的模型名>"
export OPENAI_API_KEY="<你的 API Key>"
```

### 方式二：用户配置文件

为避免每个终端都导出变量，可把**非机密**的模型配置写入用户文件
`~/.oh-my-cli/settings.json`。文件中**永远不保存凭据本身**，只保存承载凭据的
环境变量名称：

```json
{
  "model": {
    "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "name": "<你的模型名>",
    "apiKeyEnv": "DASHSCOPE_API_KEY"
  }
}
```

各字段的解析优先级（从高到低）：

| 字段 | 1（最高） | 2 | 3（最低） |
|---|---|---|---|
| 端点地址 | `OPENAI_BASE_URL` | `model.baseUrl` | 内置默认值 |
| 模型名称 | `OPENAI_MODEL` | `model.name` | （必填） |
| 凭据 | `OPENAI_API_KEY` | `model.apiKeyEnv` 指定的环境变量 | （必填） |

安全说明：配置文件只读取用户级默认路径或显式 `--settings <path>` 指定的路径，
**从不自动发现项目内的配置文件**，因此不受信任的仓库无法改写你的端点或凭据；
`model.apiKey` 这类原始凭据字段会被拒绝，请一律使用 `apiKeyEnv` 引用环境变量。

### 验证配置

```bash
oh-my-cli --doctor      # 只读检查运行时与安装状态
oh-my-cli --preflight   # 打印脱敏后的模型/端点/凭据来源摘要（会发起网络请求）
```

`--preflight` 的输出只包含脱敏摘要，永远不会打印凭据值。

## 启动 CLI

非交互方式执行单个请求：

```bash
oh-my-cli -p "列出当前目录的文件"
```

进入交互式 REPL：

```bash
oh-my-cli
```

自动化与 CI 场景可追加 `--output json`，得到版本化的事件流输出。

### 会话恢复

每次运行都以 JSONL 形式持久化在 `~/.oh-my-cli/sessions/`，并以原子检查点
（临时文件重命名覆盖正式文件）封口，中断写入不会留下半截文件。

```bash
oh-my-cli --list-sessions          # 列出可恢复会话（脱敏摘要）
oh-my-cli --resume <session-id>    # 按 id 恢复会话
oh-my-cli --browse-sessions        # 交互式搜索并选择恢复（需要终端）
```

恢复会还原会话声明的工作区；当目标会话缺失、损坏或工作区不存在时，命令会
明确失败并给出可操作信息，而不会静默恢复其他内容。

## 启动 Desktop

Desktop 是本地工作台，与 CLI 共用同一套持久化会话：

```bash
npm run desktop
```

该命令会先构建再启动 Electron 应用。在 Desktop 中你可以：

- 在左侧会话栏创建、搜索、重命名、归档/恢复与确认删除会话；
- 新会话从草稿状态开始，首轮对话完成后获得稳定标题，重命名永不被自动覆盖；
- 切换会话保留各自的草稿与阅读位置，重新加载窗口后依旧恢复；
- 打开、编辑并保存工作区内的 UTF-8 文本文件（1 MiB 上限、路径限定、原子保存）。

Desktop 的安全姿态：渲染进程开启上下文隔离与沙箱、禁用 Node 集成，只通过
类型化的 IPC 白名单与主进程通信；会话访问限定在当前工作区；智能体文件编辑
使用 `auto-edit` 审批级别，shell 类工具在 Desktop 提供原生审批界面之前保持
拒绝。

## 安全边界

- **审批模式** — `default`：每个变更类工具都需确认（无终端时拒绝）；
  `auto-edit`：允许 `write`/`edit`，shell 仍需确认；`yolo`：全部放行，
  不安全，仅在明确知情时使用。
- **工作区限定** — 文件工具被限定在工作区目录内，符号链接逃逸会被检测并拒绝。
- **会话与凭据安全** — 会话保存在用户目录；输出前会对密钥样式的字符串脱敏；
  会话导出（`--export-session`）在写入任何字节之前完成脱敏，且仅本地保存。
- **撤销与重做** — 每个非交互回合记录内容级检查点，`--undo-turn` /
  `--redo-turn` 只回退该回合自身修改的文件与消息，不影响你已有的工作。

查看当前沙箱状态：

```bash
oh-my-cli --sandbox-info
```

## 常见故障排查

| 现象 | 可能原因 | 处理 |
|---|---|---|
| `Configuration error: OPENAI_API_KEY is required` | 缺少环境变量 | 导出 `OPENAI_API_KEY`（及 `OPENAI_MODEL`），或配置 `settings.json` |
| `--doctor` 报告 Node 运行时检查失败 | Node 版本低于 22 | 升级到 Node.js 22+ |
| `interactive mode requires a TTY` | 当前没有终端 | 改用非交互方式：`-p "<提示词>"` |
| `Provider error` / 连接失败 | 端点地址或 Key 错误、网络不通 | 检查 `OPENAI_BASE_URL` / `OPENAI_API_KEY`，再运行 `--preflight` |
| `--doctor` 显示状态目录 `✗ not writable` | `~/.oh-my-cli` 不可写 | 修复用户目录权限 |

问题仍存在时，先重新运行 `--doctor` 与 `--preflight`，保留它们的脱敏输出，
再按 [CONTRIBUTING.md](../CONTRIBUTING.md) 提交问题报告。
