---
title: 网络、TLS 与 WebSocket
lastUpdated: 2026-11-10
---

# 网络、TLS 与 WebSocket

下表和 `MAR_PUBLIC_ORIGIN` 配置适用于自行部署的 HTTPS 入口。[npm Quick Start](../getting-started/npm-quick-start.md#远程访问)默认使用回环 HTTP，并固定应用 Origin；它不读取该环境变量覆盖值。通过安全隧道访问时保留同一浏览器回环地址和端口，不要将下述环境变量配置直接套用到 Quick Start。

| 链路            | 方向           | 要求                                     |
| --------------- | -------------- | ---------------------------------------- |
| 浏览器 → Server | 入站 HTTPS/WSS | 域名、证书、Origin 一致                  |
| Node → Server   | 出站 HTTPS/WSS | 不需要 Node 公网入站端口                 |
| 浏览器 → Node   | 局域网 UDP     | 文件、Git 与终端直连，默认 `49152-49215` |
| Server → MySQL  | 内网 TCP       | MySQL 不对公网开放                       |

Server 同一 HTTP listener 提供 Web、帮助、API 和 WebSocket；外部基础设施终止 TLS。反向代理必须保留 WebSocket Upgrade，并对长连接设置合理超时；`MAR_PUBLIC_ORIGIN` 必须是浏览器看到的 HTTPS Origin。不要混用 HTTP 页面和 HTTPS API/WSS。

Node 不提供浏览器 HTTP API，也不应开放任何公网入站端口。普通 Workspace 的文件、Git 和终端可按能力与授权使用局域网直连；托管对话不使用该路径。启用时，Node 启动后从私有配置 `directTransfer.udpPortRangeBegin..udpPortRangeEnd` 指定的范围内取得一个 UDP 端口，并通过 ICE UDP Mux 复用该端口；默认范围为 `49152-49215`。防火墙只应允许实际 Browser 局域网来源访问对应范围，不得向公网放行。需要精确防火墙规则时可把起止值设为同一个固定端口；同主机多个 Node 应分别配置不同端口。端口不可达时可使用 Server 中继，不会因此导致 Node 离线；已经开始的传输仍可能失败，需要重试。

**成功标志：** 登录后实时状态会更新，Node 在线，终端可以连接并在短暂断网后重连。

常见现象：502 先查代理上游和容器健康；登录/CSRF 拒绝先查 Origin；Node 反复离线先查其出站 DNS、证书与代理限制。下一步：[Node 注册失败或离线](../troubleshooting/node-offline.md)。
