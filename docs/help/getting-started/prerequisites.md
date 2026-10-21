---
title: 部署前准备
lastUpdated: 2026-10-11
---

# 部署前准备

这篇文档帮助你在部署前确认主机、网络和 Agent 条件。

## 前置条件

- 一台可运行 Docker Compose 的 Server 主机，或能自行提供 MySQL 8.4、Server 和 Web 的运行环境。
- 一个供浏览器访问的 HTTPS 域名；生产环境应由反向代理终止 TLS。
- 每台 Windows、Linux 或 macOS 工作主机安装 Node.js `>=22.13`，并为 Node 运行账号准备可读写的 Workspace；托管对话仅部署在具备 Bubblewrap 的 Linux Node。
- 使用内置 MAR Agent：不需要外部 Agent CLI，管理员须先[配置、启用并授权模型](../runners/mar-agent.md)，且当前用户处于所绑定凭据的作用域内。
- 使用 Codex、Claude Code 或 OpenCode：仅安装需要的 Agent CLI，并在同一 Node 服务账号下完成登录或模型服务配置。

## 检查清单

1. 为 Server 准备 `MAR_PUBLIC_ORIGIN`，例如 `https://mar.example.com`；它必须与浏览器实际访问地址完全一致。
2. 准备两个强密码：MySQL root 密码和 MySQL 应用账号密码。
3. 确认 Server 可对外提供 HTTPS，Node 主机可向该地址发起 HTTPS/WSS 出站连接。
4. 在每台 Node 主机用最终服务账号执行 `node --version`、`npm --version`。使用 MAR Agent 时，在管理页测试模型；使用外部 Agent 时再检查对应 CLI 版本。
5. 记录需要登记的真实 Workspace 路径，不要将整个磁盘作为 `allowedRoots`。

**成功标志：** 所有 Node 主机都能解析并访问 Server 域名，且服务账号能进入目标 Workspace。

## 常见问题

- 浏览器与 `MAR_PUBLIC_ORIGIN` 不一致：登录或 WebSocket 可能被 Origin 校验拒绝；先统一协议、域名和端口。
- Agent 在交互终端可用、服务中不可用：通常是服务账号的用户目录或 `PATH` 不同，按[Node 安装与注册](../deployment/node-installation.md)配置。

下一步：[部署 Server 与 Web](server-installation.md)。

所有部署都要求有效的真实主机 UUID。容器必须将宿主 `/sys/class/dmi/id/product_uuid` 只读挂载到 `/license-host/product_uuid`，源文件必须存在；原生运行可用 `MAR_LICENSE_HOST_PATH` 指定真实 UUID 文件。社区与企业使用相同要求。
