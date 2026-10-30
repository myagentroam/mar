---
title: 使用 marctl 管理节点
lastUpdated: 2026-10-30
---

# 使用 marctl 管理节点

`marctl` 是社区版和企业版的节点命令行工具；Node 安装包自带 `marnodes`、`marssh`、`marscp` 入口，仅供 MAR 内部执行上下文使用。它通过 Server 授权列出节点、打开交互终端、执行一次命令或复制文件；不需要 Node 开放 SSH 端口。`ssh` 是方便记忆的子命令名，**不是系统 SSH 协议**。

在 Node 上由 MAR 打开的普通 Workbench 终端、Workspace Agent Run 及其本地 MCP 子进程中，这些命令会自动加入 `PATH`。脚本可用 `MAR_NODE_CONTEXT=1` 判断 MAR 启动上下文，用 `MAR_USERNAME` 识别当前 MAR 账号的用户名（不是昵称或系统账号）；定时任务使用任务 owner 的用户名。没有可信执行身份时用户名为空，不继承 Node 服务进程的用户名。这些变量只提供上下文信息，不代表已获得节点权限，也不改变托管对话的独立沙箱边界。

## Agent 按需加载指南

在具备 marctl 执行上下文的受管 Workspace 中，MAR Agent 使用内建 `marctl` Skill；Codex、Claude Code 和 OpenCode 使用内建 `mar_cli` MCP 的 `load_guide` 工具按需读取同一份指南。服务与工具描述提供简短提示，客户端是否展示服务描述取决于对应 Runner。

加载指南只返回说明，不执行命令；Agent 仍通过自己的 Shell 工具运行 marctl，必要时查询本地命令帮助。已经加载且仍在上下文中的指南可以直接复用。该入口不增加权限，也不改变协作消息来源或现有定时任务工具。

## 查看命令帮助

```text
marctl help
marctl help ssh
marctl ssh --help
marnodes --help
marssh --help
marscp --help
```

这些入口也支持 `-h`，查看帮助无需配置、授权或连接 Server。`marctl help` 显示产品说明、统一用法、子命令、选项、示例与授权说明；子命令帮助按用法、参数、选项、示例和说明组织。各 alias 只显示自己的操作，并使用 `marnodes`、`marssh` 或 `marscp`，不会混入其他命令。`marssh <节点> tool --help` 中的帮助参数属于远端命令；`marscp --` 后的参数按字面路径处理。

## 查看 CLI 版本

```text
marctl version
marctl --version
marnodes --version
marssh --version
marscp --version
```

这些入口也支持 `-V`，以单行 `marctl <版本号>` 输出到标准输出并以换行结束，不附加横幅、依赖版本或诊断信息；查询成功时退出码为 0。显示的是当前安装的 `@myagentroam/marctl` 包版本，不是 Node 或 Server 版本；查看版本不需要配置或授权，也不会连接 Server。`marctl help version` 或 `marctl version --help` 查看版本命令说明。`marssh <节点> --version` 中的选项属于远端命令，不会改为显示本机 CLI 版本。

## 执行上下文授权

CLI 仅供 MAR 内部执行上下文使用。在 Node 上由用户打开的 Workbench 终端或发起的 Workspace Agent Run 中，CLI 自动使用当前用户的节点权限；定时任务使用任务 owner 的权限。无需配置密钥、环境文件或手动设置授权变量。

Server 在每次请求中复核用户凭证、账号、登录 Session（适用时）和当前权限。凭据**自签发起 24 小时到期**，不滑动续期、不自动续签；到期后重新打开终端或提交新的受权输入。Goal 接续和工具调用不会续签。普通系统终端或其他外部脚本不能独立访问节点；不支持管理员密钥、主目录配置文件或 `--env-file`。不要复制、保存或外传执行上下文中的用户凭证。

## 协同工作区会话

`show/config/history/graph/rename/prompt` 及 `schedule get/create/update` 可省略会话 ID，默认使用执行上下文中的当前会话；显式 ID 优先，没有当前会话时明确报错，不猜测最近会话。`send/goal/stop/wait/approval` 始终要求显式目标 ID；`list` 和 `schedule list` 仍查询当前 Workspace。

使用 `marctl agents rename [<session-id>] --title 'fixer#42 Updated title' --json` 修改标题，首尾空白会去除，标题须非空且最多 160 字符。不限制 parent 关系，沿用 Web 改名链路，不启动或打断执行。查询当前标题使用 `agents current --json`。

定时任务与内置 MCP 共用数据和修改规则：修改同一用户保存的任务直接生效，修改其他用户的任务返回 `PENDING` 提议，由原保存者确认，不转移执行身份。定时执行与手动执行使用相同的用户权限和任务修改规则。更新必须先读取当前 `revision`，再传 `--expected-revision`；冲突或写入结果不明时不自动重试。MAR Agent 的 marctl 内置技能可用时隐藏重复的定时 MCP；不可用及其他 Runner 保留原 MCP。

```text
marctl agents schedule list --limit 20 --json
marctl agents schedule get --json
marctl agents schedule create --cron '0 9 * * *' -m 'Check build results' --json
marctl agents schedule update --expected-revision 1 --message-file task.txt --json
marctl agents schedule get <session-id> --json
```

`schedule list` 分页查询 Node SQLite，返回 `tasks[]`（含 `sessionTitle`）和 `nextCursor`，不扫描 Runner。其他任务操作可显式指定目标会话；创建要求 cron 和正文，更新至少指定一项。正文沿用 `-m` / `--message-file`（支持 stdin），最多 20,000 字符；时区由 Node 确定。CLI 不提供任务启停、删除或提议审批操作。

`history --json` 在 `segments[].items[]` 中按 `kind === "assistant_message"` 筛选，文本在 `payload.text`；精简状态字段见下文。

已有会话可用 `marctl agents config <session-id> --model-id <id> --effort high --json` 切换模型和思考强度，两个选项也可单独使用；未指定字段和权限保持不变，`--effort ""` 使用 Runner 原生默认值。配置只影响既有链路中的后续执行，不重启当前执行；`agents start` 也支持 `--effort`。

`--model-id` 使用目标 Runner 配置中的 `models[].id`。MAR Agent 对应内部模型配置 ID，不是显示名或上游模型 ID。请求和会话摘要使用 `modelId`；旧 `--model` 选项及请求字段 `model` 均拒绝。

通过 `start`、`send` 或 `goal set` 派发的任务默认抑制自动通知，避免协作会话反复推送。该规则适用于后续任务轮次和 Goal 续作；运行状态和历史仍可正常查看。后续人工输入恢复普通通知规则。显式通知工具仍可按授权发送。

`sessions` 由 MAR 授权绑定当前 Node 和 Workspace，不接受 `--node`、`--workspace` 或其他范围覆盖；已知其他范围的会话 ID 或 cursor 不代表获得访问权。Workspace 终端可能没有当前会话；缺少可信工作区上下文时明确报错。既有 `nodes`、`ssh`、`scp` 的跨 Node 行为不变。

会话列表、ID 定位及 `list --query <名称片段>` 只查询当前 Node 已登记或缓存的会话，不主动扫描 Runner。MAR 创建的正式会话和成功发现的外部会话会登记；尚未发现的外部会话需先由工作台发现。查询不恢复执行。置顶会话优先排序，但仍遵守分页。错填 ID 时，`SESSION_NOT_FOUND` 的 `details` 可返回同一 Workspace 内最多 3 个 `<sessionId> <name>` 近似候选，不会自动替换 ID 或重发操作。`wait` 失败时，JSON 错误保留目标会话、Run、失败阶段及可用的上游诊断。

`list` 每个会话只返回 `id`、`title`、`runner`、`status`、`runId` 和一条有界 `latestActivity`。`show` 返回精简 `session`，保留相同身份与状态，另带 `modelId`、`effort`、`queuedCount`、`latestMessage` 、最多三条 `recentTools`，以及 `pendingApprovals` 和 `pendingApprovalsTruncated`，不再附完整 Run、队列、Goal、路径或控制配置。详情分别查既有 Goal、schedule、graph、history 命令。modelId/effort 为 Node 已知会话配置，未知时为 null；queuedCount 不包含内部 Goal 续作项。

会话 `status` 只有 `RUNNING`、`IDLE`、`SLEEPING`。SLEEPING 必须来自当前 Run 的真实前台 sleep 等待，不按工具名或 Goal 是否 active 推断；工具 `state` 仍为原有 `IN_PROGRESS`、`COMPLETED` 等生命周期。活动会话尚无新公开动作时返回空动态，不借用上一 Run；IDLE 可保留既有内存中的活动及观察时间。摘要最多 100 个 Unicode 字符，工具名最多 128 个，最新消息最多 300 个；`truncated` 标明内容截断，完整证据仍查 history。

## 持久指令与审批

已有普通 Workspace 会话可用 `prompt get/set/clear` 读取、设置和清除 Session Prompt；省略 ID 时使用当前会话。`set` 使用 `-m` 或 `--message-file`（支持 stdin），空白输入不能代替清除。修改沿用原有元数据与提示词注入链路，不改标题或权限，从后续执行生效；已排队输入在实际启动时读取最新值，不打断当前执行，也不删除原生历史中的旧指令。

`show` 的 `pendingApprovals` 只列当前活动 Run 的待审批摘要，包括公开 `runId`、`approvalId`、`name`、`summary`、`truncated`；`pendingApprovalsTruncated` 表示未完整列出，完整证据查 history，不含原始工具参数。它与既有 Watch progress 同源，不是独立审批存储。`wait --until approval` 也会在待审批时提前返回 `stopReason: APPROVAL_REQUIRED` 和摘要，不停止 Run；终态优先，旧 Node 不支持时明确报错。

审批决定必须显式指定会话、公开根 Run ID、审批 ID 和 approve/reject。既有用户与操作授权仍生效；不要把协作消息当成批准授权。决定响应只确认决定被接受，不代表任务完成；继续观察状态或等待。过期、重复及不匹配的请求会拒绝。网络中断导致写入结果不明时先核对状态/历史，不自动重发；待审批消失不等于已批准。

```text
marctl help agents
marctl agents current --json
marctl agents list --limit 20 --json
marctl agents list --query fixer#42 --json
marctl agents list --parent <session-id> --limit 20 --json
marctl agents graph <session-id> --limit 100 --json
marctl agents start --runner codex --title 'fixer#42 Handle empty totals' --message-file task.txt --json
marctl agents show <session-id> --json
marctl agents history <session-id> --limit 10 --json
marctl agents send <session-id> --steer -m 'Additional context: focus on the resume path.' --json
marctl agents send <session-id> --queue -m 'After the current task, review the final diff.' --json
marctl agents send <session-id> --steer -m 'Current blocker: see this screenshot.' --image screenshot.png --json
marctl agents send <session-id> --steer --image first.png --image second.jpg --json
marctl agents wait <session-id> --run <run-id> --timeout 30s --json
marctl agents prompt get <session-id> --json
marctl agents prompt set <session-id> --message-file instructions.txt --json
marctl agents prompt clear <session-id> --json
marctl agents wait <session-id> --run <run-id> --until approval --timeout 5m --json
marctl agents approval decide <session-id> --run <run-id> --approval <approval-id> --decision approve --json
marctl agents wait <session-id> --timeout 0ms --json
marctl agents stop <session-id> --execution <execution-id> --json
marctl agents goal get <session-id> --json
marctl agents goal set <session-id> --message-file objective.txt --json
marctl agents goal set <session-id> -m 'Finish the review and verify the fix' --json
marctl agents goal clear <session-id> --json
```

`start`、`send` 和 `goal set` 可用 `-m` / `--message` 直接传文本，也可用 `--message-file` 读取 UTF-8 文件或 stdin，两种选项互斥。`start`、`send` 还可重复传入 `--image <路径>`，与文本组合或只发送图片。图片从 CLI 所在主机读取，使用既有 Session 图片附件链路发送，不是远端路径引用。支持 PNG、JPEG、GIF、WebP，最多 5 张，单张 5 MiB、合计 10 MiB；实际图片能力仍取决于目标 Runner 和模型。`goal set` 只接受文本，并拒绝保留目标 `--clear`；清除目标请显式使用 `goal clear`。

`start` 在工作区根目录创建会话并提交首条消息，支持 `mar-agent`、`codex`、`claude-code`、`opencode`，以实际 Runner 能力为准。省略 `--model-id` 时使用目标 Runner 的配置，不继承 Coordinator 模型。创建会话不会覆盖 Web Composer 已保存的默认模型、思考强度或权限，无论是否来自父会话；指定的配置只影响新建会话。`--message-file -` 从 UTF-8 stdin 读取。保存返回的原生会话 ID，标题不是唯一寻址身份。

Agent 内执行 `start` 时，Node 根据可信 Execution 凭据核验创建来源；终端用户可用 `--parent` 指定合法父会话，Node 校验同一 Workspace 后保存正式 `parentSessionId`。没有父会话则为空，创建后不能修改。`list --parent <session-id>` 按直接子会话筛选并分页，`graph <session-id>` 返回包含根的创建后代树。graph 默认最多 100 个节点，`--limit` 支持 1..100；结果包含 `rootSessionId`、`nodes` 和 `truncated`，只查询 Node 已知会话，不扫描 Runner。parent 只表示创建来源，不是权限、当前调度者或任务依赖；发送消息与接手不改变它。删除父会话会按 Node 的关系树删除后代；旧会话不从消息或标题推断关系。

按任务需要创建会话，标题用 `fixer#<任务编号> <描述>`、`reviewer#<任务或变更编号> <描述>`。没有固定人数、角色注册、会话池；角色、范围和验收条件可放入首条普通消息，持久指令通过 `prompt` 设置。各 Runner 按上文入口加载指南；目标会话不需要加载该指南才能接受协作消息。

`send` 默认按普通发送处理，也可显式选择互斥的 `--steer` 或 `--queue`；冲突、重复或旧选项在读取输入或发送请求前本地拒绝。`--steer` 优先补充新信息，受管等待可提前返回，后台任务继续；其他情况可能切换当前执行，Node 按实际状态裁决。及时协作优先使用 `--steer`；仅明确希望当前执行结束后再处理的后续工作使用 `--queue`。排队的消息按顺序处理，后来的显式停止仍有效。有活动 Goal 时可能等待 Goal 退出才处理。start/send 自动生成 `clientMessageId`，也可传入 `--client-message-id`。消息回执在 `message.status` 和 `message.result` 中报告接受及投递事实，不代表模型已处理或业务已完成；排队回执应以 `queueItemId`/`clientMessageId` 和历史核对。

Agent 会话中的 `start` 首条消息和 `send` 消息会在历史和队列中标注 `来自 {name}`，使用发送时的名称快照；悬停显示来源为会话及其 ID。网页分享访客消息使用相同的 `来自 {name}` 标题，悬停显示来源为网页分享；普通用户与分享页面原作者保留原有标题。终端用户直接输入不伪造会话来源。内部来源标记不会出现在消息正文中。

不带 `--run` 的 `wait` 默认等待直接子会话终态 30 秒，`--timeout 0ms` 读取快照；从快照取得的 `executionId` 可用于 `stop --execution`，过期身份不会取消后来的执行，stop 同时清除相应 Goal。`wait --run` 通过既有 Watch 等待指定 Run 或审批，退出时释放观察；超时错误可附最后收到的有界 `progress`，没有观察时省略。无论哪种等待，超时或取消等待都不停止任务。Run 成功仍需核验产物与测试；子会话终态不会自动唤醒父会话的 sleep，需主动等待或读取。

只有直接子会话的公开更新会被父会话自动收取。向其他会话 `send` 不建立订阅；显式 `wait` 只在本次调用期间监听，不会持续接收其后续更新。

会话共享文件和 Git 索引，不自动隔离 worktree 或创建 Git 工作流。提交、推送、PR、合并和外部消息仍需相应用户授权。变更结果未知时保留关联 ID，先查状态/历史再决定是否重试，不盲目重发；重启后不保证恢复内存回执或 Run。

`--json` 只输出一个结果/错误对象，key 和 code 使用稳定英文。退出码：1 失败，2 参数错误，3 授权错误，4 能力不支持，5 超时，6 结果未知，130 取消等待。

## 列出节点与执行命令

```text
marctl nodes
marnodes
marctl ssh <node-id>
marctl ssh <node-name>
marssh <node-id|node-name>
marctl ssh <node-id> uname -a
marscp ./artifact.bin <node-id|node-name>:///absolute/path/artifact.bin
marscp ./artifact.bin <node-id|node-name>:///existing/directory/
marscp <node-id|node-name>:///absolute/path/artifact.bin ./
marscp <node-id|node-name>:///absolute/path/artifact.bin ./artifact.bin
marctl scp linux:///absolute/path/artifact.bin windows://C:\absolute\path\artifact.bin
```

`nodes` 仅列出当前授权用户有终端使用权的 Node，首行是节点 ID、名称、在线状态、平台的列标题；`ssh` 可使用节点 ID，或使用在可访问节点中唯一的精确节点名称（包括离线节点在内进行重名检查）。同名时会拒绝连接并提示使用 ID；ID 与其他节点名称相同时优先匹配 ID。不带命令时打开交互 Shell。带命令时，CLI 按 SSH 的常见形式把节点后的参数传给远端 Shell，显示输出并返回真实退出码，便于 Agent 或脚本判断成功与否；拼接后的命令最多为 64 KiB UTF-8 字节，目标平台或 Shell 可能有更低限制。节点后以 `-` 开头的参数也是远端命令内容，无需额外的 `--`。不支持 `-t`、登录账号、端口、私钥等系统 SSH 选项，也不自动提权。不要在命令中传入密钥。

CLI 优先尝试既有 Node 直连，建连失败时回退 Server 中继；回退使用同一个终端，不重复创建或执行命令。两种传输方式都由 Server 授权，命令始终以 **Node 服务账号**运行。企业 ADMIN 可以操作自己的个人 Node 和全部组织 Node，但不能使用其他用户个人 Node 的终端。

`scp` 支持当前机器与有权限的 Node 之间、两个有权限的 Node 之间复制单个普通文件。Node 端点使用 `<节点ID|节点名称>://<绝对路径>` 或 `节点:<绝对路径>`，名称须在可访问 Node 中唯一，重名时使用节点 ID；没有节点前缀的路径是本机路径。与标准 `scp` 一样，已有普通目标文件默认覆盖，无需特殊开关，并保留原目标权限；`-p` 保留源文件权限及访问/修改时间，`-q` 不显示进度（默认已不显示）。其他 SCP 参数（包括 `-r` 和 SSH 专属连接选项）明确拒绝而非静默忽略。已有真实目标目录会自动追加源文件名，不必写完整目标文件名；以分隔符结尾的目录目标必须已存在，不会自动创建目录或误建同名文件。源目录、符号链接源或目标，以及目录内最终路径为目录或符号链接的情况均拒绝；源文件名在接收平台不合法时也会拒绝。完整校验后原子发布，传输失败不会替换原文件；强制终止进程时可能留下临时文件。传输复用授权的二进制 pipe 模式 Terminal 链路，**不是**系统 SCP 协议，也不新增文件 API。旧 Server 或 Node 不支持二进制 Terminal 时直接拒绝，不会通过 PTY 传输任意字节。文件访问遵循各 Node 服务账号的权限；路径含空格时需要按本机 Shell 语法加引号。Windows Node 路径可在 `://` 后使用 `C:\absolute\path`。

## 长任务与断线

Server 中继不设置固定传输速率上限。发送端逐帧异步写入，并让出事件循环处理其他操作；复制拥塞时暂停相应 pipe 或 CLI 输入，恢复后按顺序继续，不影响直连写者。普通终端持续读取以保留退出前的完整尾部；发送缓冲超限时明确终止对应中继，不静默丢帧或关闭其他终端的共享连接。退出状态不会越过输出，等待写入或确认时仍可中断；成功退出后的正常断线不会被误报为复制失败。无需新增命令参数；慢网络仍可能增加响应时间，这不是主机级带宽隔离。

连接建立有超时，但附着后的命令没有总运行时长或输出静默超时；保持连接即可等待长任务正常完成。CLI 退出或连接无法恢复时会关闭其创建的终端，不提供断线后的后台任务托管；Node 上已解除附着的终端最多保留 60 分钟。对于必须在断线后持续运行的作业，请另行使用受控的任务管理方式，不要依赖这个终端连接。
