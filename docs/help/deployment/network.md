---
title: 网络、TLS 与 WebSocket
lastUpdated: 2026-10-11
---

# 网络、TLS 与 WebSocket

| 链路            | 方向           | 要求                         |
| --------------- | -------------- | ---------------------------- |
| 浏览器 → Server | 入站 HTTPS/WSS | 域名、证书、Origin 一致      |
| Node → Server   | 出站 HTTPS/WSS | 不需要 Node 公网入站端口     |
| 浏览器 → Node   | 局域网 UDP     | 文件直传，默认 `49152-49215` |
| Server → MySQL  | 内网 TCP       | MySQL 不对公网开放           |

Server 同一 HTTP listener 提供 Web、帮助、API 和 WebSocket；外部基础设施终止 TLS。反向代理必须保留 WebSocket Upgrade，并对长连接设置合理超时；`MAR_PUBLIC_ORIGIN` 必须是浏览器看到的 HTTPS Origin。不要混用 HTTP 页面和 HTTPS API/WSS。

Node 不提供浏览器 HTTP API，也不应开放任何公网入站端口。普通 Workspace 文件直传启用时，Node 启动后从私有配置 `directTransfer.udpPortRangeBegin..udpPortRangeEnd` 指定的范围内取得一个 UDP 端口，并通过 ICE UDP Mux 让 Probe 与后续文件传输复用该端口；默认范围为 `49152-49215`。防火墙只应允许实际 Browser 局域网来源访问对应范围，不得向公网放行。需要精确防火墙规则时可把起止值设为同一个固定端口；同主机多个 Node 应分别配置不同端口。端口不可达时文件操作会完整回退 Server 中继，Node 在线、托管对话和其他工作台能力不受影响。

**成功标志：** 登录后实时状态会更新，Node 在线，终端可以连接并在短暂断网后重连。

常见现象：502 先查代理上游和容器健康；登录/CSRF 拒绝先查 Origin；Node 反复离线先查其出站 DNS、证书与代理限制。下一步：[Node 注册失败或离线](../troubleshooting/node-offline.md)。
