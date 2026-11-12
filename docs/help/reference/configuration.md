---
title: 配置项参考
lastUpdated: 2026-11-12
---

# 配置项参考

| 配置                                                 | 位置           | 用途                                                                                    | 是否敏感/重启          |
| ---------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------- | ---------------------- |
| `MAR_PUBLIC_ORIGIN`                                  | Server 环境    | 浏览器实际访问的 HTTP/HTTPS Origin、OAuth 回调                                          | 否；改后重启 Server    |
| `MAR_SERVER_HOST`                                    | Server 环境    | Server 监听地址；Quick Start 默认 `127.0.0.1`，可设为 `0.0.0.0` 对外监听                | 网络相关；重启 Server  |
| `MAR_SERVER_BIND_ADDRESS` / `MAR_SERVER_PUBLIC_PORT` | Compose 环境   | 宿主机发布地址 / 端口，默认 `127.0.0.1` / `5190`；直接 HTTP 可自行开放预期入口          | 网络相关；重建 Server  |
| `MAR_SECURE_COOKIES`                                 | Server 环境    | 默认按公开入口协议选择 Secure；仅需要显式覆盖时设置 `true` / `false`，HTTP 无需额外关闭 | 安全相关；重启 Server  |
| `MAR_WEB_PUSH_SUBJECT`                               | Server 环境    | VAPID 联系地址，接受 `mailto:` 或 HTTPS，与站点协议独立；未配置时复用 HTTPS 公开 Origin | 否；重启 Server        |
| `MAR_DATABASE_URL`                                   | Server 环境    | MySQL 连接                                                                              | 是；改后重启 Server    |
| `MAR_DATA_DIR`                                       | Server 环境    | Server 本地持久数据根目录                                                               | 路径敏感；重启 Server  |
| `MAR_SERVER_SSH_DIR`                                 | Compose 环境   | 宿主机部署账号的完整 `.ssh` 绝对路径                                                    | 敏感；重建 Server      |
| `MAR_SEARXNG_SECRET`                                 | Compose 环境   | 内置 SearXNG 的随机服务密钥                                                             | 是；重建 SearXNG       |
| `MAR_SKILL_CACHE_MAX_BYTES`                          | Server 环境    | Skill 缓存容量上限，默认 10 GiB                                                         | 否；改后重启 Server    |
| `serverUrl`                                          | Node 私有 JSON | Node 连接的 Server 地址                                                                 | 否；重启 Node          |
| `allowedRoots`                                       | Node 私有 JSON | 可登记 Workspace 根目录                                                                 | 否；重启 Node          |
| `dataDirectory`                                      | Node 私有 JSON | Node SQLite、升级等私有数据根目录                                                       | 路径敏感；重启 Node    |
| `directTransfer.udpPortRangeBegin`                   | Node 私有 JSON | 局域网直连 UDP 范围起点，默认 `49152`                                                   | 防火墙相关；重启 Node  |
| `directTransfer.udpPortRangeEnd`                     | Node 私有 JSON | 局域网直连 UDP 范围终点，默认 `49215`                                                   | 防火墙相关；重启 Node  |
| `conversationHosting.enabled`                        | Node 私有 JSON | 是否在 Linux Node 启用 Bubblewrap 托管对话；支持的 Node 可由管理页写入                  | 安全敏感；管理页热启停 |
| `conversationHosting.storeDirectory`                 | Node 私有 JSON | `dataDirectory` 内的托管对话相对目录；启用时必填                                        | 路径敏感；重启 Node    |
| `conversationHosting.inactiveRetentionDays`          | Node 私有 JSON | 自动永久清理非活跃对话的阈值，默认 60，范围 1–365 天                                    | 数据保留；重启 Node    |
| `computerUse.enabled`                                | Node 私有 JSON | 是否授权 Node 使用受管 Python/PyAutoGUI 控制交互桌面，默认关闭                          | 安全敏感；管理页热启停 |
| `MAR_CLAUDE_CONTEXT_WINDOW_TOKENS`                   | Node 服务环境  | Claude Code 上下文窗口显示上限                                                          | 否；重启 Node          |
| `MAR_AGENT_WEB_FETCH_ALLOW_UNTRUSTED_TLS`            | Node 服务环境  | 默认 `1`；设为 `0` 时要求 MAR Agent Web Fetch 校验 HTTPS 证书                           | 安全敏感；重启 Node    |

Node 包版本检测与 Supervisor 安装自动读取对应运行账号的标准 npm 配置，不提供额外 Registry 配置项。Server 与 Node 使用不同运行账号时，应分别配置账号的 npm 环境；不要把 npm 凭据写入 Node JSON。

Node 配置还会在首次注册后写入 Node ID 与凭据，应按敏感文件保护。密钥值请通过[环境密钥](../administration/secrets.md)配置，不要写入公开配置示例或 Git。

“系统配置 > HTML 预览域名”可指定不同主机名的 HTTP 或 HTTPS Origin（如 `https://preview.example.com`），须由管理员事先设置 Console 的 `MAR_PUBLIC_ORIGIN`，配置 DNS、HTTPS 时的 TLS，以及仅转发同一 Server 预览资源路由的反向代理。仅更换端口不隔离 Cookie。留空时使用控制台当前 Origin；此时 HTML/JS 运行于登录环境，不提供权限隔离。HTML 可以加载其所在目录及下级文件，也可以发起外网请求；仅运行可信任的文件。

局域网直连 UDP 起止端口必须同时设置，范围限于 `1024..65535` 且最多包含 256 个端口。Node 启动时从范围内取得一个空闲端口，并通过 ICE UDP Mux 让该进程的所有 Probe、文件传输与终端直连复用此端口；主机防火墙只允许实际 Browser 局域网来源访问对应范围。不配置时使用默认 `49152..49215` 共享端口池。同主机多个 Node 会分别取得空闲端口；需要固定单端口时将起止值设为相同端口，需要隔离时为各 Node 配置互不重叠的单端口或范围。端口池耗尽或不可达不会影响 Node 上线，受支持的文件和终端操作可使用 Server 中继，进行中的操作可能需要重试。

托管目录必须是 `dataDirectory` 内的非空相对路径，不能使用绝对路径、`.`、`..` 或越界片段。支持的在线 Linux Node 可由系统管理员在节点详情启用或禁用；启用会保留既有目录和保留天数配置，缺失时使用 `hosted-conversations` 与 60 天默认值，并立即热初始化。禁用保留现有目录、SQLite 索引和会话历史；但只要有活动或启动中的托管 Run，Node 就会拒绝禁用，不会取消用户对话。变更目录或保留天数前应停止 Node、完成备份并确认不会留下另一份无人管理的数据。自动非活跃清理按阈值永久删除候选会话；用户确认删除对话后也会立即永久删除，不保留恢复期。

`computerUse.enabled` 缺失时按 `false` 处理，应通过节点详情开关管理而不是手工编辑。开启后 Node 异步下载或复用固定版本的 npm 受管 Runtime，校验后安装到私有目录并探测当前交互桌面；不会调用 pip 或回退到系统/Workspace Python。包未发布、下载失败或损坏时能力保持不可用并报告稳定原因。`computerUse.runtimeExecutable` 只保留给开发和验证覆盖，不应用于生产配置。

使用 `git@host:owner/repo.git` 技能源时，Server 以自身运行用户执行非交互 Git 读取。Compose 将 `MAR_SERVER_SSH_DIR` 指向的部署账号完整 `.ssh` 目录只读挂载到 `/home/node/.ssh`；目录必须使用绝对路径，部署账号 UID 应与容器 `node` 用户默认 UID `1000` 一致，`IdentityFile` 应使用 `~/.ssh/` 下的容器可见路径。Server 镜像内置 Git 与 OpenSSH 客户端，但不会保存、修改或分发这些 SSH 文件。技能源请求固定跳过 SSH 主机指纹校验，不依赖 `known_hosts`。

Skill 内容自动保存到 `MAR_DATA_DIR/skills`，Server 日志自动保存到 `MAR_DATA_DIR/logs`；Node 日志自动保存到 `dataDirectory/logs`，均不单独配置路径。Server 和 Node 日志按天或单文件 100 MiB 滚动并保留 7 天，同时继续写入标准输出。Skill 缓存预计用量超过上限的 80% 时 Server 写入告警日志；超过 90% 时停止新增收藏和收藏升级，但不影响读取或安装已有缓存。

所有部署都要求有效的真实主机 UUID。容器必须将宿主 `/sys/class/dmi/id/product_uuid` 只读挂载到 `/license-host/product_uuid`，源文件必须存在；原生运行可用 `MAR_LICENSE_HOST_PATH` 指定真实 UUID 文件。社区与企业使用相同要求。
