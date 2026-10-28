---
title: 生产部署与反向代理
lastUpdated: 2026-10-29
---

# 生产部署与反向代理

生产部署由 MySQL、自带 Web 的 Server 和外部 HTTPS 基础设施组成，不需要额外的产品 Web/Nginx 服务。Node 控制连接只需向 Server 出站；可选的局域网直连 UDP 配置见[网络说明](network.md)。

## 前置条件

完成[部署 Server 与 Web](../getting-started/server-installation.md)，并拥有域名、证书和反向代理管理权。

## 步骤

1. 将 `MAR_PUBLIC_ORIGIN` 设为用户浏览器实际访问的 `https://` Origin。
2. Compose 会把其所在目录的 `./data` 绑定到 Server 通用数据目录；部署账号应创建并备份该目录，Server 会在其中维护 `skills/` 与 `logs/`。
3. 将 `MAR_SERVER_SSH_DIR` 指向独立部署账号的 `.ssh` 绝对路径。Compose 会把整个目录只读挂载到容器 `/home/node/.ssh`；该账号应只持有 Server 读取技能源所需的 SSH 凭据，宿主机 UID 应与容器 `node` 用户默认 UID `1000` 一致。
4. 让反向代理把整个站点转发到宿主机 `5190`。该端口直接映射到 Server `5190` listener，统一提供页面、公开 `/docs/`、API 和 WebSocket；不要为这些路径设置不同 Origin。
5. 为 WebSocket 保留 `Upgrade` 和 `Connection` 请求头，并把读取超时设置为可覆盖长时间 Agent 任务和终端连接。
6. 仅将需要的端口暴露给公网；MySQL 和 Server 回环端口不应直接公开。

Nginx 最小示例（证书配置按你的环境补充）：

```nginx
location / {
  proxy_pass http://127.0.0.1:5190;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto https;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection $connection_upgrade;
  proxy_read_timeout 3600s;
}
```

如果外层 Nginx 没有定义 `$connection_upgrade`，在 `http {}` 中增加 `map $http_upgrade $connection_upgrade { default upgrade; '' close; }`。其他代理产品应配置等价的 WebSocket 转发，并关闭对实时接口的响应缓存。

**成功标志：** HTTPS 登录、公开文档、Node 在线状态、Agent 实时回复和终端都可用；直接刷新任意 `/docs/...` 文档链接仍能打开同一篇文档。

失败时先用[网络、TLS 与 WebSocket](network.md)检查，再查看容器健康与代理日志。
