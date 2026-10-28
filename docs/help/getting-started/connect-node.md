---
title: 接入第一台 Node
lastUpdated: 2026-10-29
---

# 接入第一台 Node

目标是在一台实际存放工作区并运行 Agent 的主机上注册 Node。

Server 不包含 Node 执行器。即使 Node 与 Server 位于同一主机，也需要独立安装并注册 Node；托管对话另有 Linux 和 Bubblewrap 前提。

## 前置条件

- 已可登录 MyAgentRoam。
- 目标主机满足[部署前准备](prerequisites.md)中的 Node 条件。
- 你有权创建 Node 注册密钥，并可在目标主机的 Node 服务账号下安装和运行程序。

## 步骤

1. 打开“管理 → 节点管理”，点击“注册节点”，填写节点名称和归属后创建注册密钥。创建成功会关闭表单并打开独立确认弹窗，显示注册密钥、使用说明和部署指引；关闭前请复制并保存注册密钥，再按照部署说明在目标设备上完成节点注册。
2. 在目标主机安装 `@myagentroam/node`，写入私有配置文件。
3. 以前台方式执行 `mar-node run --config <配置文件>`。
4. 回到“节点”页，确认该 Node 显示在线；再到“管理 → 节点管理”打开详情，确认“支持 Agent”与本机实际安装一致。验证完成后再设置 systemd 或任务计划自启动。

**成功标志：** 节点详情显示正确的平台、Node.js 版本和支持的 Agents。

## 失败排查

- 注册密钥只能使用一次；失败后请重新创建注册密钥。
- Node 离线时先检查 `serverUrl`、本机时间、出站 TLS/WSS 和服务日志。
- Agent 未出现时，先在 Node 实际运行账号下检查安装、`PATH` 和登录状态。

下一步：[安装与注册 Node](../deployment/node-installation.md)提供完整 Linux/Windows/macOS 指引；随后[登记 Workspace](register-workspace.md)。
