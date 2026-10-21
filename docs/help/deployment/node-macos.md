---
title: macOS Node 与 launchd
lastUpdated: 2026-09-12
---

# macOS Node 与 launchd

目标是以拥有 Agent 登录状态和 Workspace 权限的固定 macOS 用户运行 Node。先完成[安装与注册 Node](node-installation.md)中的前台验证。macOS Node 支持工作区、Agent、文件、Git 和 POSIX PTY 终端；托管对话依赖 Bubblewrap，仍须使用 Linux Node。

## 步骤

以下命令必须由目标 macOS 用户执行，不要使用 `sudo`、root 或另一个登录账号。将配置和数据放在该用户私有目录：

```bash
config="$HOME/.config/myagentroam/mar-node.json"
plist="$HOME/Library/LaunchAgents/com.myagentroam.node.plist"

mkdir -p "$(dirname "$config")" "$HOME/Library/Application Support/MyAgentRoam" "$(dirname "$plist")"
chmod 700 "$(dirname "$config")" "$HOME/Library/Application Support/MyAgentRoam"
chmod 600 "$config"

mar-node install --config "$config" --output "$plist"
plutil -lint "$plist"
launchctl bootout "gui/$(id -u)" "$plist" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$plist"
launchctl kickstart -k "gui/$(id -u)/com.myagentroam.node"
launchctl print "gui/$(id -u)/com.myagentroam.node"
```

`mar-node install` 生成的 LaunchAgent 以 `mar-node supervise --config` 启动 Node；`launchctl bootstrap` 才会登记并启动它。生成文件包含 Homebrew 和系统常用目录的 `PATH`。如果 `node`、`npm`、`mar-node` 或外部 Agent CLI 通过 nvm、Volta 或其他自定义目录安装，先编辑 plist 中 `EnvironmentVariables.PATH`，再重新执行 `bootout`、`bootstrap` 和 `kickstart`；不要依赖交互式 shell 初始化文件。

## 自启动与远程升级验收

确认以下条件：

- `launchctl print` 显示 `com.myagentroam.node` 已加载，且 `ProgramArguments` 包含 `supervise --config`，而不是 `run --config`；
- 目标用户可读写配置、`dataDirectory`、Workspace，并可读取该用户自己的 Agent 登录与 npm 配置；
- 在该用户的非交互环境中，`node`、`npm`、`mar-node` 可解析；按实际用途再检查 `npx`、`git`、`python3`/`python`、`pip3`/`pip`、`opencode`、`codex` 和 `claude`；
- 重新登录该用户或执行 `launchctl kickstart -k "gui/$(id -u)/com.myagentroam.node"` 后，Node 以原有身份自动上线，节点详情不显示“需手工启用 Supervisor”。

Supervisor 会将远程升级版本安装到 `dataDirectory/node-versions/<版本>/`，并在 LaunchAgent 进程中切换 Node 子进程。管理端推送不会创建或修改 LaunchAgent，也不会提升权限；首次自启动配置必须在 macOS 主机上完成。

**成功标志：** 节点页显示在线，重启 LaunchAgent 或重新登录用户后自动重连，详情显示已启用 Supervisor 升级能力，并且可打开 Workspace、终端和已配置的 Agent。

如果 Node 未启动，先检查 `launchctl print` 的退出状态、plist 的 `ProgramArguments` 和 `PATH`、配置路径、目标用户的用户目录与 Workspace 权限。不要切换为 root 来绕过 Agent 登录或路径问题。
