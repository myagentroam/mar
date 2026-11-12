---
title: 安装与注册 Node
lastUpdated: 2026-11-12
---

# 安装与注册 Node

本页适用于把 Windows、Linux 或 macOS 主机接入 MyAgentRoam。Node 只主动连接 Server，不提供浏览器 HTTP API，也不需要向公网暴露本机端口；普通 Workspace 文件、Git 和终端直连需要仅对 Browser 局域网开放限定 UDP 范围。完成后节点详情会显示在线状态和已发现的 Agents。托管对话因依赖 Bubblewrap 沙箱，仍仅支持 Linux Node。

## 前置条件

同一个本地数据目录只能有一个 Node 运行实例。重复启动会报告 `NODE_DATA_DIRECTORY_IN_USE` 并退出；先通过原实例的服务或终端正常停止它，再重新启动。不要删除 `node-owner.sqlite` 来绕过占用检查。Supervisor 会停止本次重复启动的内部重试，但外部服务管理器仍可能按自己的策略重启服务。

正常重启和受控升级会在旧实例退出后交接。普通断线不会停止已接受的执行，控制连接被替换也不代表旧主机上的执行已结束；本地目录排他不覆盖复制到另一目录或主机的身份，不应通过复制凭据规避重复实例错误。

- Node.js `>=22.13`；最终运行服务的账号也必须能找到同一个 `node` 与 `mar-node`。
- 可访问 Server 的公开 HTTP 或 HTTPS 地址；Node 对应使用出站 WS 或 WSS。普通工作区直传的网络要求见下文。
- 目标 Workspace 在 `allowedRoots` 内，且运行账号有相应目录权限。
- 首次接入可使用[内置 MAR Agent](../runners/mar-agent.md)：无需外部 Agent CLI，由管理员配置并授权模型。若使用 Codex、Claude Code 或 OpenCode，则在**同一服务账号**下完成对应 CLI 安装、登录或模型服务配置。

在该账号下检查：

```bash
node --version
npm --version
codex --version
claude --version
opencode --version
```

不使用的 Agent 可忽略。使用 Claude Code 时还应确认官方认证状态；自启动使用服务账号自己的用户目录和 `PATH`，因此不能只在管理员或 SSH 登录账号下完成安装。CLI 在交互终端可执行后，仍须按平台文档重启服务并在节点详情确认对应 Runner 已显示可用。

Node 还会在服务账号环境中探测以下按需工具，并在节点详情的“工具环境”中显示实际命令、版本和路径。它们缺失时 Node 仍可上线，只影响使用对应功能：

| 工具                 | 使用场景                                      | 是否必须              |
| -------------------- | --------------------------------------------- | --------------------- |
| `npx`                | 启动 npm 包形式的 MCP Server，例如 Playwright | 仅使用此类 MCP 时需要 |
| `git`                | Git Workspace 与 Git 技能源                   | 使用对应功能时需要    |
| `python3` / `python` | Python Skill 或 Agent 调用的 Python 工具      | 按项目需要            |
| `pip3` / `pip`       | 为 Python 工具安装依赖                        | 按项目需要            |

安装完成后应以最终服务账号复查节点详情，而不是只依据管理员终端中的结果。详情显示“未发现”时，先在同一服务账号和服务使用的 `PATH` 下运行对应命令，再重启 Node 或等待下一次能力探测。Node.js 版本单独显示；`node` 和 `npm` 不在“工具环境”中重复列出。

## 安装与配置

1. 从当前产品的发布清单确认公共组件版本 `commonVersion`，安装该精确版本的跨平台 npm 包。Server/Web、Node、Agent 和 Protocol 使用同一版本基线；清单的 `productVersion` 与 `commonVersion` 必须相等。安装仍以清单指定的精确版本为准，不使用浮动的 npm `latest`：

   ```bash
   common_version='<产品发布清单中的 commonVersion>'
   npm install --global "@myagentroam/node@${common_version}"
   npm list --global "@myagentroam/node@${common_version}" --depth=0
   ```

   执行前替换占位值；如果没有对应产品发布清单，先向部署管理员确认精确版本。版本号相等不替代协议与能力的兼容性检查。

   若非 root 服务账号安装全局包时遇到权限错误，可先为该账号设置用户级 npm prefix，并把其 `bin` 目录加入该账号登录环境和后续服务环境：

   ```bash
   npm config set prefix "$HOME/.local"
   export PATH="$HOME/.local/bin:$PATH"
   ```

   Supervisor 使用服务账号可写的 Node 数据目录保存版本化安装，不调用 sudo 或 UAC。首次启用需要按平台文档把自启动入口改为 `mar-node supervise`；之后管理端只会在人工确认后升级到 npm 已发布、满足业务基线且不超过当前 Server 版本的最高稳定版本，并向 Supervisor 推送选定的精确版本，详见[升级 MyAgentRoam](upgrade.md)。

   远程升级还要求服务账号在非交互环境中能够执行 `node`、`npm` 并访问 npm。检测与安装均自动使用对应运行账号的 npm 配置；无需在 Node JSON 或 Server 环境中重复配置 Registry。

2. 在控制台打开“管理 → 节点管理”，点击“注册节点”，填写名称和归属后创建注册密钥。创建成功后，在独立确认弹窗中保存注册密钥，并按说明填入目标 Node 配置的 `registrationToken` 字段。注册密钥只能使用一次，Node 连接成功后会显示在节点列表中。
3. 在私有目录创建配置文件；Linux 示例：

   ```json
   {
     "serverUrl": "https://mar.example.com",
     "allowedRoots": ["/home/mar-node/workspaces"],
     "dataDirectory": "/home/mar-node/.local/share/myagentroam",
     "directTransfer": {
       "udpPortRangeBegin": 49152,
       "udpPortRangeEnd": 49215
     },
     "registrationToken": "从节点注册页复制的注册密钥"
   }
   ```

   Windows 示例：

   ```json
   {
     "serverUrl": "https://mar.example.com",
     "allowedRoots": ["C:\\Users\\mar-node\\workspaces"],
     "dataDirectory": "C:\\ProgramData\\MyAgentRoam",
     "directTransfer": {
       "udpPortRangeBegin": 49152,
       "udpPortRangeEnd": 49215
     },
     "registrationToken": "从节点注册页复制的注册密钥"
   }
   ```

   macOS 示例：

   ```json
   {
     "serverUrl": "https://mar.example.com",
     "allowedRoots": ["/Users/mar-node/workspaces"],
     "dataDirectory": "/Users/mar-node/Library/Application Support/MyAgentRoam",
     "directTransfer": {
       "udpPortRangeBegin": 49152,
       "udpPortRangeEnd": 49215
     },
     "registrationToken": "从节点注册页复制的注册密钥"
   }
   ```

4. 限制配置与整个 `dataDirectory` 只能由运行账号读取；SQLite 位于其根目录，结构化日志位于其 `logs/`，都不能放在 npm 包目录、Git 或聊天中。
5. 前台验证：

   ```bash
   mar-node run --config /path/to/mar-node.json
   ```

首次连接成功后，Node 会将 Node ID 和凭据写回配置，后续用凭据重连；可移除已使用的 `registrationToken`。

从使用 `databasePath` 的旧版 Node 升级时，必须先把该字段改为 SQLite 所在目录对应的 `dataDirectory`，并确认数据库文件名为 `node-runtime.sqlite`；新版本会拒绝旧字段，不自动搬迁数据。

自定义 Claude Code 上下文窗口时，可在 Node 服务环境设正整数 `MAR_CLAUDE_CONTEXT_WINDOW_TOKENS`（例如 `256000`）；未设置时默认按 200000 tokens，并可读取该服务账号 Claude 配置中的同名环境值。

**成功标志：** 注册页显示节点在线、正确的平台/Node.js 版本和支持 Agent。此时按平台配置自启动：[Linux systemd](node-linux.md)、[Windows 任务计划](node-windows.md)或[macOS launchd](node-macos.md)。

完成自启动后必须再检查一次远程升级前置状态：重启主机或服务后 Node 自动上线，节点详情中的“升级状态”显示“当前无需升级”或“可升级到 …”，而不是“需手工启用 Supervisor”。不支持 Supervisor 的旧版需要先手工安装符合当前业务基线的版本并改好自启动入口；旧 Node 无法通过未知操作自举 Supervisor。

## 接入后检查与失败排查

1. 在 `allowedRoots` 下登记 Workspace，确认文件、终端和 Agent 会话均可打开。
2. 重启 Node 服务后，确认它自动重连；不要开放 Node 公网入站端口。需要局域网直连时，只允许 Browser 所在局域网访问配置的 UDP 范围，默认 `49152-49215`。同主机多个 Node 可共享默认池并自动选择空闲端口；需要独立容量时，为各配置文件设置互不重叠的范围。
3. Node 在线但 Agent 不可用时，先以服务账号检查 CLI、`PATH`、用户目录、认证和工作区权限。
4. MCP 启动失败时，在节点详情确认 `npx` 是否可用；Python Skill 失败时确认页面显示的实际 Python/pip 命令，并在同一服务账号下复现。
5. Node 完全离线时，检查 Server URL、HTTP/WS 或 HTTPS/WSS 出站网络、配置权限与服务日志。

安全提示：注册密钥、Node 凭据和 Agent 登录状态都不可提交 Git 或发送给 Agent。下一步：[登记第一个 Workspace](../getting-started/register-workspace.md)。

## Web Fetch 浏览器准备

Node npm 包的 `postinstall` 自动准备其固定 Playwright 版本对应的 Chromium；已有匹配缓存时直接复用。受管升级即使禁用 npm lifecycle scripts，也在切换版本前显式准备浏览器，失败时保留旧版本；`mar-node install` / `upgrade` 也会执行准备。普通启动和工具调用不会下载浏览器。

请在最终服务账号下安装。默认缓存属于安装账号；若安装与运行账号不同，须在安装和服务环境设置相同的 `PLAYWRIGHT_BROWSERS_PATH`，并确保服务账号可读取及执行。离线部署可预置匹配平台和 Playwright 版本的 Chromium，再设置 `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` 跳过下载；跳过不代表浏览器已可用。手动准备可运行安装包内 `scripts/install-web-browser.mjs`。

npm 安装控制库不等于安装浏览器二进制或 Linux 系统库。Node 自动下载浏览器，但不会执行 sudo、UAC 或自动安装系统包。`MAR_AGENT_WEB_FETCH_BROWSER_UNAVAILABLE` 表示浏览器无法启动：先检查匹配缓存、服务账号和路径；Linux 精简环境还可能缺少 Chromium 系统库，由管理员按需安装。HTTP 模式不依赖浏览器，失败不会自动切换模式。

生成的服务默认把浏览器缓存放在 Node 数据目录的 `web-browsers/`，准备步骤与服务启动使用同一路径；显式的 `PLAYWRIGHT_BROWSERS_PATH` 会被保留。Linux unit 保持 `ProtectSystem=strict` 并允许该缓存路径写入，受管升级复用服务环境。首次采用此流程的旧服务需按平台指南重新生成并应用服务定义；Node 不自行修改已部署服务或账号。仍须确保最终服务账号能读取、执行缓存。
