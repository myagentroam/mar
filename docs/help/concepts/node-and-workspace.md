---
title: Node 与 Workspace
lastUpdated: 2026-10-22
---

# Node 与 Workspace

Node 是运行 Agent 的具体主机；Workspace 是该 Node 上登记的一个真实目录。

| 概念          | 含义                                          | 不能做什么                         |
| ------------- | --------------------------------------------- | ---------------------------------- |
| Node          | 一台 Windows/Linux/macOS 主机及其服务账号环境 | 不向浏览器公开端口                 |
| allowedRoots  | Node 配置中允许登记的根目录                   | 不是任意路径白名单绕过方式         |
| Workspace     | `allowedRoots` 下已登记目录                   | 不跨 Node 共享磁盘路径             |
| Git Workspace | 位于 Git 仓库中的 Workspace                   | 不要求所有 Workspace 都是 Git 仓库 |

登记后，文件、Git、会话和终端都以 Workspace 为边界。删除 Node 或注销 Workspace 只移除 Server 登记和授权，不会删除宿主机文件。

工作区标签的 Node 名称旁会显示绿点和“未读”：绿点表示该工作区在当前账号的最近会话中有正在启动、运行或停止的任务；“未读”表示仍有未读会话通知，两者可同时出现，非当前标签也会更新。标记沿用[通知中心](../workbench/conversation.md#阅读步骤)的数据和已读规则：从会话列表打开会话会标记该会话通知已读，其他会话的未读保留；点击一条通知只标记该条。列表刷新或连接恢复后自动同步，短任务可能在标记出现前已结束。

当前标签的 Node 名称带下划线时表示点对点直连已连接，悬浮可查看原有连接说明；它不表示 Node 在线或会话正在运行。

如果目录被移动、权限改变或符号链接指向边界外，重新选择 Workspace 前先修正 Node 的 `allowedRoots` 与实际路径。详见[Workspace、文件或 Git 不可用](../troubleshooting/workspace-files.md)。
