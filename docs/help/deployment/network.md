---
title: 网络、TLS 与 WebSocket
lastUpdated: 2026-11-12
---

# 网络、TLS 与 WebSocket

Server 支持外部 HTTP/HTTPS 访问，WebSocket 对应使用 WS/WSS，不按公网、内网或回环地址额外设限。`MAR_PUBLIC_ORIGIN` 必须与浏览器实际访问的协议、主机和端口完全一致。[npm Quick Start](../getting-started/npm-quick-start.md#远程访问)默认回环监听，也支持通过环境变量配置对外入口。

| 链路            | 方向                      | 要求                                     |
| --------------- | ------------------------- | ---------------------------------------- |
| 浏览器 → Server | 入站 HTTP/WS 或 HTTPS/WSS | 地址与 Origin 一致；HTTPS 时证书可信     |
| Node → Server   | 出站 HTTP/WS 或 HTTPS/WSS | 不需要 Node 公网入站端口                 |
| 浏览器 → Node   | 局域网 UDP                | 文件、Git 与终端直连，默认 `49152-49215` |
| Server → MySQL  | 内网 TCP                  | MySQL 不对公网开放                       |

Server 同一 HTTP listener 提供 Web、帮助、API 和 WebSocket；可以直接提供 HTTP，也可以由外部基础设施终止 TLS。使用反向代理时必须保留 WebSocket Upgrade，并对长连接设置合理超时。Web、API 和 WebSocket 应使用同一公开入口；不要让 HTTPS 页面连接明文 HTTP API 或 WS。Cookie 的 Secure 属性默认按公开入口协议选择，不必为 HTTP 额外关闭项目限制。HTTPS 可防止链路上的明文窃听和篡改，建议用于不可信网络。

Node 不提供浏览器 HTTP API，也不应开放任何公网入站端口。普通 Workspace 的文件、Git 和终端可按能力与授权使用局域网直连；托管对话不使用该路径。启用时，Node 启动后从私有配置 `directTransfer.udpPortRangeBegin..udpPortRangeEnd` 指定的范围内取得一个 UDP 端口，并通过 ICE UDP Mux 复用该端口；默认范围为 `49152-49215`。防火墙只应允许实际 Browser 局域网来源访问对应范围，不得向公网放行。需要精确防火墙规则时可把起止值设为同一个固定端口；同主机多个 Node 应分别配置不同端口。端口不可达时可使用 Server 中继，不会因此导致 Node 离线；已经开始的传输仍可能失败，需要重试。

**成功标志：** 登录后实时状态会更新，Node 在线，终端可以连接并在短暂断网后重连。

常见现象：502 先查代理上游和容器健康；登录/CSRF 拒绝先查 Origin；Node 反复离线先查其出站 DNS、证书与代理限制。下一步：[Node 注册失败或离线](../troubleshooting/node-offline.md)。

## 浏览器能力

HTTP 下在线工作台可正常使用；项目内部 UUID 和 SHA-256 不依赖安全上下文。复制、PWA 安装、Service Worker 离线缓存、系统通知及 Web Push 是否可用，由浏览器提供的 API、权限和外部服务决定；不支持时按能力降级，不阻止其他操作。普通外部 HTTP 通常不具备这些安全上下文能力，回环地址可能例外。Web Push 联系地址由 `MAR_WEB_PUSH_SUBJECT` 独立配置（`mailto:` 或 HTTPS）；HTTPS 站点未配置时沿用公开 Origin。
