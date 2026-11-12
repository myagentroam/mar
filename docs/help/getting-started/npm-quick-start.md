---
title: npm 快速开始
lastUpdated: 2026-11-12
---

# npm 快速开始

Quick Start 一次准备默认社区版 Server、专用 MySQL 和本机 Node，并在支持受管搜索的平台准备 SearXNG。默认通过本机回环 HTTP 访问；远程访问的网络入口和安全配置由你自行管理。它不安装系统常驻服务。Linux 使用 `/etc/machine-id`，无需读取硬件 UUID 或提权；常规 Web 不显示升级操作，管理员可通过 [License API](../administration/license.md#linux-一键包的管理员-api)获取申请码和导入授权，npm 与 pnpm 安装行为相同。Windows 仍固定社区版，不提供激活。另一种安装方式见 [Docker Compose 部署](server-installation.md)。

目前实际验证的安装目标是带 glibc 2.28 或更高版本、`tar` 和 `dpkg-deb` 的 Linux x64（例如受支持的 Debian 或 Ubuntu 系统），以及可使用 `tar` 的 Windows x64。需要 Node.js 24.12 或更高版本以及 npm。安装包时原生依赖可能要求系统已有可用的构建工具；安装和 setup 均不安装系统包，也不请求提权。浏览器和所选组件的准备需要网络。其他原生平台尚未完成此 Quick Start 的验证。

终端依赖固定为 `node-pty@1.2.0-beta.18`，随包提供 Linux x64/arm64、macOS x64/arm64 和 Windows x64/arm64 预编译文件；已验证的 Linux x64 默认安装无需为 node-pty 安装 GCC、make 或 Python，程序目录和 HOME 含空格也可使用。不要设置 `npm_config_build_from_source=true` 或全局跳过安装脚本；前者会强制源码编译，后者可能使其他依赖未正确准备。其他原生依赖或无匹配预编译文件的平台仍可能需要构建工具；包内有预编译文件不代表该平台的完整 Quick Start 已验证。

## 安装与启动

当 npm Registry 中已有 Server 包及其所需依赖后，以普通用户运行：

```bash
npm install @myagentroam/server
npx --no-install mar-server setup
npx --no-install mar-server run
```

Server 以普通依赖使用同版本 Node；npm 安装会按 Node 原有生命周期安装原生依赖并准备 Chromium，即使之后使用 `--no-node`。安装或查看 `mar-server --help` 不配置、注册或启动本机 Node。setup 下载所选固定组件并初始化专用数据库，不使用已有 MySQL，也不接受 `MAR_DATABASE_URL`。跳过本地搜索使用 `--no-searxng`；两个参数可以组合。搜索准备是可选步骤，失败会报告但不会丢弃其他组件。

`--no-node` 会持久保存禁用选择，但不会从 Server 包移除 Node 依赖。之后如需启用本机 Node，先停止 run，在 `server.json` 中将 `node.enabled` 设为 `true`，保留身份，再运行 setup。

run 在前台运行并打印本机浏览器地址。使用 Ctrl+C 停止并等待子进程退出；run 不会下载缺失组件。同一数据目录不能并发执行 setup 和 run。

Linux 启动要求 `/etc/machine-id` 可读且包含有效的非全零 32 位十六进制身份；缺失或无效时报告 `LICENSE_HOST_UNAVAILABLE`，不会自动生成替代值。重装系统或变更该身份后，已有企业 License 需要重新签发。激活不替换一键包或重建已有数据。

Windows 本机 Quick Start 的受管 Node 使用 IPv4 直连；如果只能通过 IPv6 连接，文件和终端流量会回退到 Server 中继。

## 远程访问

默认本机访问不是使用场景限制。Quick Start 支持外部 HTTP/HTTPS；setup 不会配置域名、TLS、防火墙或访问控制。HTTPS 需由代理或隧道提供，建议用于不可信网络；HTTP 为明文传输。入口须支持 WebSocket。

run 默认监听 `127.0.0.1`。设置 `MAR_SERVER_HOST` 可调整监听地址，设置 `MAR_PUBLIC_ORIGIN` 可指定浏览器实际使用的 HTTP 或 HTTPS Origin（含非默认端口，不含路径）；Cookie 策略随公开入口协议选择。例如在 Bash 中执行 `MAR_SERVER_HOST=0.0.0.0 MAR_PUBLIC_ORIGIN=http://192.168.1.10:5190 mar-server run`，其中端口应替换成 `server.json` 的 `serverPort`。Windows 可在当前终端设置相同环境变量。反向代理或隧道转发须与该 Origin 一致；不要关闭 Origin 校验绕过配置问题。受管 MySQL、搜索和本机 Node 的内部连接不会因此全部对外开放。网络与浏览器能力边界见[网络、TLS 与 WebSocket](../deployment/network.md)。

## 更新 Server 与受管 Node

1. 正常停止 run，等待其管理的进程全部退出。
2. 在原 npm 安装目录安装目标 Server 版本，例如 `npm install --save-exact @myagentroam/server@X.Y.Z`，将 `X.Y.Z` 替换为已发布且依赖齐全的目标版本。
3. 用原配置重新执行 `npx --no-install mar-server run`；此前使用 `--config` 时继续传入同一路径。刷新浏览器并确认原 Node、工作区和终端可用。

Node 随 Server 的精确依赖一起更新，不单独使用节点管理中的推送升级。不要删除部署目录、重建 Node 身份或修改 `allowedRoots` 来完成更新；重复 setup 不是更新 npm 程序的方式。独立 Node 的升级流程见[升级 MyAgentRoam](../deployment/upgrade.md)。

以上步骤更新 Server/Node 的 npm 程序，不会自动升级已有的受管 MySQL 或搜索组件。更新前核对目标版本的发行说明；若要求组件迁移，按该版本说明操作，不要手工删除安装记录来强制重装。

## 登录并开始工作

按[首次登录与修改密码](first-login.md)立即修改初始管理员密码。等待本机 Node 显示在线，再在部署目录的 `workspace` 下[登记 Workspace](register-workspace.md)。本机 Node 默认只能访问该目录，不会自动启用托管对话。[开始会话](first-agent-session.md)前还需配置模型和凭据；Node 在线或 `/health` 成功并不代表 Agent 已能执行。

本机 Node 的默认允许目录仅为本部署的 `workspace/`。如需使用其他项目，先停止 run，只编辑部署数据目录内 `node-data/node.json` 的 `allowedRoots` 数组，填写一个或多个绝对路径，然后重新 run。例如 Unix 可用 `"allowedRoots": ["/home/alice/project", "/srv/work"]`，Windows 可用 `"allowedRoots": ["C:\\Projects", "D:\\Work"]`。不要覆盖整个文件或删除 `nodeId`、凭据及 `serverUrl` 等身份字段。允许目录不会提升操作系统账号权限；账号仍需有相应文件权限。npm 程序安装目录与部署数据目录不同，后者默认为 `~/.myagentroam/quick-start/`，也可由 `--config` 指定。

首次注册失败后，可停止并重新 `run`：若 `node.json` 只有注册令牌、尚无身份，系统会复用未使用的有效令牌，或替换已过期但未使用的令牌，保留允许目录和数据配置。若报告 `QUICK_START_NODE_BOOTSTRAP_RECOVERY_REQUIRED`，说明令牌已使用或状态无法确认，系统不会自动重复登记。请保留 `node-data/node.json`，从备份恢复已有身份，或先核对并处理管理页面中的上次登记；不要直接删除配置或数据目录。身份字段残缺会报告配置无效，不会自动重置身份。

## 数据与可选搜索

默认私有配置、凭据和组件数据位于 `~/.myagentroam/quick-start/`。如需其他私有位置，setup 和 run 均传入相同的 `--config /path/to/server.json`。请保护并备份该目录。重复 setup 保留凭据、Node 数据、Workspace 及其他组件版本。受管 Node 程序随 Server 依赖更新，不使用独立升级或活动入口。

`server.json` 的 `search` 对象只有 `managed`、`disabled`、`external` 三种模式。Windows 不支持受管 SearXNG；如需搜索，可使用外部服务。如需使用已有 SearXNG，停止 run，只将 `search.mode` 改为 `"external"`、将 `search.url` 改为服务地址，保留已有的 `search.installation` 记录，再重新启动。该服务必须允许 JSON 搜索。JSON 检查失败时，本次运行不提供客户端搜索，也不会回退到其他地址；`web_fetch` 和模型托管搜索是独立能力。`--no-searxng` 不会清除外部地址。

禁用后如需重试本地搜索，停止 run，将搜索模式设为 `managed`，保留已有 `installation` 记录，再运行 setup。不受支持的平台请保持禁用并改用外部地址。独立管理 Node 参见 [Node 安装](../deployment/node-installation.md)，正式运维参见[生产部署](../deployment/production.md)。
