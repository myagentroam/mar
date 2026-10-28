---
title: 端口、配置目录与数据位置
lastUpdated: 2026-10-29
---

# 端口、配置目录与数据位置

| 项目            | 默认/示例                     | 说明                                                                     |
| --------------- | ----------------------------- | ------------------------------------------------------------------------ |
| Server 容器端口 | `5190`（内外一致）            | 同时提供 Web、API、WebSocket 和健康检查；HTTPS 由外部基础设施提供        |
| MySQL 主机映射  | `13006`                       | Compose 默认映射到主机；应限制访问，不能直接对公网开放                   |
| Node 直连       | UDP `49152-49215`             | 文件、Git 与终端仅允许 Browser 局域网来源，不对公网开放                  |
| Node 配置       | 自定义私有 JSON               | 通过 `--config` 或 `MAR_NODE_CONFIG` 指定                                |
| Server 数据     | `MAR_DATA_DIR`，默认 `./data` | Skill 位于 `skills/`，日志位于 `logs/`                                   |
| Node 数据       | 配置旁目录或 `dataDirectory`  | SQLite 位于根目录，日志位于 `logs/`                                      |
| Agent 配置目录  | Node 服务账号自己的用户目录   | 外部 Runner 的配置与历史按各自规则管理；MAR Server 模型凭据另存于 Server |

路径必须以 Node 服务账号的视角确认。Linux systemd、Windows 任务计划和 macOS launchd 经常因为用户目录或 `PATH` 不同而找不到 Agent 或历史。

Node 直连端口范围可通过私有 JSON 中的 `directTransfer.udpPortRangeBegin` 和 `directTransfer.udpPortRangeEnd` 调整；两项必须同时设置，范围最多包含 256 个非特权端口。每个 Node 进程从范围中取得一个端口，并通过 ICE UDP Mux 复用它。同主机多个 Node 可以共享默认池并分别选择空闲端口，也可以配置互不重叠的范围；需要固定端口时把起止值设为相同值。修改后重启 Node，并同步更新仅限局域网来源的主机防火墙规则。

Server 和 Node 日志按天或单文件达到 100 MiB 时滚动，仅保留最近 7 天；标准输出仍保留同样的结构化日志，供 Docker、systemd 或任务计划采集。
