---
title: Node 注册失败或离线
lastUpdated: 2026-10-29
---

# Node 注册失败或离线

## 排查步骤

1. 在 Node 主机确认服务进程仍运行，并读取 service/systemd/任务计划日志。
2. 检查配置中的 `serverUrl` 是浏览器可访问的 HTTPS Origin，系统时间正确。
3. 从 Node 主机测试 DNS、TLS 和到 Server 的出站 HTTPS/WSS；控制连接不需要公开 Node HTTP API。可选直连 UDP 配置见[网络说明](../deployment/network.md)。
4. 首次注册失败时重新创建一次性令牌；已注册 Node 应使用写回配置的 Node ID 与凭据重连。
5. 恢复后观察节点详情中的心跳、平台与 Agent 列表。

**成功标志：** 节点在线并能打开其 Workspace。

若只有 Agent 不可用而 Node 在线，转到[Agent 排障](../runners/runner-troubleshooting.md)。

## Node 在线但请求需要用户授权

`USER_AUTHORIZATION_REQUIRED` 不代表 Node 离线。在线状态来自节点连接和心跳；读取 Workspace 等操作还需要通过单次用户授权校验。

单次授权声明的有效期最多 15 秒，签发与到期边界各允许最多 1 小时时钟偏差（含边界），因此 Server 与 Node 的时钟相差 ±1 小时仍可执行合法请求。该容差不延长请求超时，也不放宽用户、会话指纹、节点、操作和请求 ID 的校验。

出现此错误时，检查两端实际系统时间；仅显示时区不同不等于时钟偏差。超出容差时先同步时钟。时间正常但仍失败时，记录节点应用版本、Server 请求 ID 和 Node 请求 ID，并关联两端日志检查授权字段和运行版本兼容性；不要仅因这个错误删除 Node 并重新注册。

## 恢复后

重新打开一个工作区，读取文件并创建短会话，确认浏览器、Server 和 Node 的连接已经恢复。不要因一次短暂离线删除 Node 并重新注册；重新注册会改变登记身份和授权关系。
