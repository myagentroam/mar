---
title: 升级 MyAgentRoam
lastUpdated: 2026-11-10
---

# 升级 MyAgentRoam

使用 npm Quick Start 时，按[更新 Server 与受管 Node](../getting-started/npm-quick-start.md#更新-server-与受管-node)操作：受管 Node 随 Server 依赖更新，不走单独推送升级。以下流程用于自行管理的 Server 和独立 Node。

升级前先完成可恢复备份。Server/Web、EE、公共 Core、Node、Agent、Protocol 统一使用同一主版本，当前基线为 `0.10.1`。公共二进制包与 Computer Use Runtime 从 `0.10.1` 起步并保留独立修订；Code Navigation 不独立发布，marctl 随 Node 交付。

## 步骤

统一产品沿用现有企业数据库结构、迁移账本、License 激活事实和私有数据目录。社区与企业使用同一安装，激活不触发数据库迁移；不提供已删除个人产品的数据迁移。

Server 与 Web 必须配套，Server 版本必须大于等于 Node；最低支持 Node `0.11.39`。先升级 Server/Web，再升级 Node，不能反向操作。切换后刷新已打开的浏览器页面，以加载匹配的 Web。wire v2 Node 不再支持连接或推送升级，必须先在主机上手工更新 Node。低于当前业务基线的已登记 wire v3 Node 不能继续处理工作区、会话等业务；支持推送升级时仍可连接，并由有权用户发起或取消升级。升级完成前不要依赖旧 Node 执行业务。升级会沿用 Node SQLite 和 Server MySQL 的既有迁移链；迁移前仍需备份，数据库不会自动降级。

### 旧数据库格式

首次从一体化 Server 切换到拆分构建不属于普通自动升级。必须先停服、验证可恢复备份，并由运维按目标版本提供的操作手册在隔离恢复副本中完成预演。旧数据库需准备到一体化 v49，再校验表结构、迁移记录及引用完整性，执行经审核的转换 SQL，并核对数据和 License 激活事实。不要直接修改版本标记或清除 License 状态。

新 Server 拒绝旧格式 ledger 时会报告 `SERVER_DATABASE_LEDGER_UNSUPPORTED`；这不是连接配置错误，不能通过删除迁移表绕过。不得将企业数据库降级为仅 Core 的结构。切换后的受支持版本继续自动执行 Core/Enterprise 增量迁移；失败时保持停服，恢复匹配版本的备份。

### 常规升级

1. 备份 MySQL、每台 Node 的私有配置与 SQLite、必要工作区，以及各 Agent 官方要求备份的配置和历史目录。
2. 选择维护窗口，确认没有关键运行中的 Agent 或终端。
3. 更新 Server/Web 容器或发布产物，启动后确认数据库迁移与 `/health` 成功。
4. Server 使用运行账号的 npm 配置查询 `@myagentroam/node` 的已发布版本，选择不超过当前 Server 版本且达到当前业务基线的最高稳定版本作为 Node 升级目标。Server 同版本尚未发布时，只有符合这两个条件的较低版本才可使用；不直接推送浮动的 `latest`，也不升级到比 Server 更新的版本。Server 检测与 Supervisor 安装都会自动读取各自运行账号的 npm 配置，不另设 Registry 配置项。
5. 已部署 Supervisor 的 Node 可在“管理 → 节点管理”打开节点详情并点击“推送升级”；系统不会自动升级，也不会降级。推送给 Supervisor 的始终是查询后确定的精确版本，而不是浮动的 `latest`。旧 Node 首次启用该能力时仍需手工更新 npm 包并按 [Linux](node-linux.md)、[Windows](node-windows.md)或[macOS](node-macos.md)文档把自启动入口改为 `mar-node supervise`。
6. 确认弹窗会说明目标版本、Run 排空和 Terminal 断开影响。推送后 Node 等待活动 Run 完成，并在等待期间拒绝新 Run、队列派发和 Terminal；“等待 Run”阶段可在节点详情取消，进入“准备重启”后不可取消。
7. Supervisor 使用固定包名安装精确版本，在目标平台重建 `node-pty`，验证入口后切换 Node 子进程。安装失败时保留旧入口并上报失败；修复 npm 网络、Registry、磁盘、权限或安全软件问题后再重新推送。
8. 确认本次升级完成且目标 Node 重新认证上线，再执行一次新会话、文件读取和终端的冒烟验证，并验证重启服务或主机后仍能自动上线。

## 节点管理中的升级状态

- “可升级到 X.Y.Z”：Node 版本低于 npm 中不超过当前 Server 版本的最高稳定版本，且已声明 Supervisor 能力；实际推送还要求 Node 在线且未禁用。
- “当前无需升级”：Node 已达到或高于当前可升级目标，无需操作且不会降级。
- “版本未知或不受支持”：Node 上报的版本缺失、非法或不是稳定版本，先手工确认并修复 Node 安装。
- “需手工启用 Supervisor”：按平台文档手工安装支持版本并把自启动入口改为 `supervise`。
- “目标 npm 包暂不可用”：无法查询已发布版本、没有同时满足 Server 版本上限与业务基线的稳定包或 Server 版本非法；等待包发布/同步，或检查 Server 版本及其运行账号的 npm 配置和网络。
- “等待 Run”：请求已受理，已有 Run 正在排空；交接前可取消，此时不能创建新 Run 或 Terminal。请求结果待确认不表示 Node 已受理，也不要盲目重复推送。
- “升级中”：显示关闭旧节点、安装版本或等待上线。安装完成不代表上线；进度更新中断只表示结果待确认，不代表安装失败。等待上线时间较长时检查主机，不要并发重推。
- “完成”：本次目标版本已经通过 Node 控制连接认证上线。之后离线不会改变本次成功记录。
- “失败”：查看页面原因、Node/Supervisor 服务日志和 `dataDirectory` 下的升级结果。只有旧操作已结束且 Node 在线时才重新推送；否则先在主机上排查。切换入口前安装失败保留旧入口，切换后启动失败不会自动回滚。

实时进度和退出超时兜底需要 Server、Node 及其实际运行的 Supervisor 均支持新能力。仅升级 Node 子进程不会更新正在运行的 Supervisor；首次启用时先升级 Server，再在维护窗口按平台文档更新 Supervisor 启动入口并重启服务。旧 Supervisor 管理的 Node 仍使用原有升级流程，不显示实时进度；已卡住的旧进程需单独处理。

如果页面没有“推送升级”按钮，先确认当前账号具有该 Node 的管理写权限、企业 License 未冻结、Node 在线且未禁用，并检查上述状态。远程升级只负责 Node npm 包和子进程，不会远程安装 Node.js、创建 systemd/计划任务、提升权限或修改 Server/Web。Server 和 Node 若使用不同运行账号，应分别保证两个账号的 npm 配置都能访问同一包版本。

**成功标志：** 所有组件版本与能力正常，Node 重连后可打开既有 Workspace。

迁移失败应停止继续升级并从备份恢复，不要手工修改数据库结构。下一步：[备份与恢复](backup-restore.md)。
