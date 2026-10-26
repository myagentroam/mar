const configurationHelp = `授权：
  仅 MAR 打开的终端和普通 Workspace Agent Run 可访问节点，定时任务使用任务 owner 的权限。
  MAR 自动提供短期用户凭证；不支持外部终端或持久管理员密钥。`;

export default Object.freeze({
  help: `marctl — MyAgentRoam 命令行工具

用法：
  marctl [选项] <子命令> [参数]
  marctl help [子命令]

子命令：
  sessions 查看和协调当前工作区中的会话。
  nodes    列出有权限的节点及连接状态。
  ssh      打开节点终端或执行远程命令。
  scp      在当前机器与节点之间、节点之间复制普通文件。
  version  显示已安装的 CLI 包版本。
  help     显示工具或指定子命令的帮助。

选项：
  -h, --help       显示帮助后退出。
  -V, --version    显示 CLI 包版本后退出。

示例：
  marctl nodes
  marctl ssh <节点> uname -a
  marctl scp ./artifact.bin <节点>:///tmp/artifact.bin
  marctl --version
  marctl help ssh

快捷命令：
  marnodes  等价于 nodes 子命令。
  marssh    等价于 ssh 子命令。
  marscp    等价于 scp 子命令。

${configurationHelp}

说明：
  帮助和版本查询离线可用，无需配置或授权。
  本机帮助、版本选项须放在节点或文件端点前。
  快捷命令仅显示对应操作的帮助。用 marctl help <子命令> 查看详细说明。
  远程访问使用授权的 Node Terminal 传输，不是系统 SSH 或 SCP 协议。`,
  commandHelp: Object.freeze({
    sessions: `{program} — 协调当前 MAR 工作区中的会话

用法：
  {program} current [--json]
  {program} list [--query <title>] [--parent <session-id>]
    [--cursor <cursor>] [--limit <1..100>] [--json]
  {program} show [<session-id>] [--json]
  {program} config [<session-id>]
    [--model <id>] [--effort <value>] [--json]
  {program} rename [<session-id>] --title <name> [--json]
  {program} prompt get|clear [<session-id>] [--json]
  {program} prompt set [<session-id>]
    (-m <text> | --message-file <file|->) [--json]
  {program} schedule list [--cursor <cursor>] [--limit <1..100>] [--json]
  {program} schedule get [<session-id>] [--json]
  {program} schedule create [<session-id>] --cron <cron>
    (-m <text> | --message-file <file|->) [--json]
  {program} schedule update [<session-id>]
    --expected-revision <revision>
    [--cron <cron>] [-m <text> | --message-file <file|->] [--json]
  {program} graph [<session-id>] [--limit <1..100>] [--json]
  {program} history [<session-id>]
    [--cursor <cursor>] [--limit <1..100>] [--json]

  {program} start --runner <runner>
    [-m <text> | --message-file <file|->] [--image <path> ...]
    [--model <id>] [--effort <value>] [--title <name>]
    [--client-message-id <id>] [--json]

  {program} send <session-id>
    [-m <text> | --message-file <file|->] [--image <path> ...]
    (--steer | --queue)
    [--client-message-id <id>] [--json]

  {program} stop <session-id> [--run <run-id>] [--json]
  {program} goal get|clear <session-id> [--json]
  {program} goal set <session-id>
    (-m <text> | --message-file <file|->) [--json]
  {program} wait <session-id>
    --run <run-id> --timeout <30s|5m> [--until approval] [--json]
  {program} approval decide <session-id> --run <run-id>
    --approval <approval-id> --decision <approve|reject> [--json]

输入：
  show/config/history/graph/rename、prompt 和 schedule get/create/update
  可省略 ID，使用当前会话；没有当前会话时请显式指定 ID。
  send/goal/stop/wait/approval 始终要求显式会话 ID。
  Runner：mar-agent、codex、claude-code、opencode，操作以实际能力为准。
  -m / --message 直接传文本，与 --message-file 互斥；
  文件用 UTF-8，- 从 stdin 读取。
  start/send 可重复 --image 传 PNG/JPEG/GIF/WebP 图片，也可只发送图片。
  最多 5 张，单张 5 MiB、合计 10 MiB；goal set 只接受文本。
  config 至少指定 model 或 effort；未指定字段和权限不变。
  --effort "" 使用 Runner 默认值，不重启当前执行。
  prompt 读取、设置或清除持久指令，从后续执行生效。

标题与定时任务：
  rename 复用现有标题更新，不限制 parent 树、不重启执行。
  schedule list 读取本地 Workspace 任务，get/create/update 与 MCP 共用任务数据。
  任务正文最多 20,000 字符；update 至少指定 cron 或正文。
  修改其他用户的任务会生成 PENDING 提议。
  更新前读取当前 revision；版本冲突不会自动重试。

读取 JSON：
  list：id/title/runner/status/runId，以及一条 latestActivity。
  show：session.status、session.title、session.runId，
    session.model、session.effort、session.queuedCount，
    session.latestMessage、session.recentTools（最多三条摘要）。
    session.pendingApprovals 展示当前审批；pendingApprovalsTruncated 标记
    摘要未完整列出，完整证据仍查 history。
  状态为 RUNNING/IDLE/SLEEPING；工具保留原有生命周期。
  history：segments[].items[] 中按 kind === "assistant_message"
    筛选，读取 payload.text。

投递与等待：
  start/send 返回 clientMessageId。
  send 必须二选一：--steer 或 --queue，空闲时也需指定。
  --steer 优先补充新信息，可能切换当前执行；
    Node 按实际状态裁决，仅用于影响当前工作的必要更新。
  --queue 排入后续轮次；有活动 Goal 时可能等待 Goal 退出才处理。
    新输入自动恢复暂停的 FIFO，不打断活动执行；取消收敛后才恢复。
  示例：
    marctl sessions send <session-id> --steer \\
      -m "Additional context: focus on the resume path." --json
  排队回执的 runId 可能属于其他活动输入，
  需按 queueItemId/clientMessageId 与可见历史核对。
  wait 通过 Watch 等待指定 Run；超时不会停止任务，
  超时错误可附 progress，表示最后观察到的有界快照。
  --until approval 在需要审批决定时也提前返回。
  approval decide 显式批准或拒绝单个请求，沿用实际用户授权；
    决定被接受不代表任务完成。
  Run 成功不等于业务完成。Worker 完成不自动唤醒 Coordinator。
  投递结果未知时先查状态/历史，不盲目重发。

凭据与范围：
  凭据自签发起 24 小时到期，不自动续签。
  MAR 绑定当前 Node/Workspace，不提供覆盖范围的参数。
  列表及 ID 定位只查 Node 已知会话，不扫描 Runner。
  --query 按展示标题筛选；ID 不存在时可提示近似候选，不自动重试。
  start 自动记录可用的当前会话为 parent，不提供 parent 覆盖参数。
  --parent 查直接子会话；graph 查包含根的后代，默认最多 100 个节点，
  截断时明确标记；创建关系不表示任务依赖。

Worker：
  按任务需要创建会话，例如 --title "fixer#42 Handle empty totals" 或
  --title "reviewer#42 Review empty totals"；标题不是寻址身份，
  保存返回的会话 ID。角色和任务要求放入首条普通消息。
  会话共享文件与 Git 索引，不自动隔离工作目录或维护池。

退出码：
  1 失败，2 参数，3 授权，4 不支持，5 超时，6 结果未知，130 取消等待。
  --json 只输出一个结果或错误对象。`,
    nodes: `{program} — 列出有权限的节点

用法：
  {program} [选项]

选项：
  -h, --help       显示帮助后退出。
  -V, --version    显示 CLI 包版本后退出。

示例：
  {program}

输出：
  以制表符分隔的节点 ID、名称、状态、平台列。
  包含当前用户有终端使用权的离线节点。

${configurationHelp}`,
    ssh: `{program} — 打开终端或执行远程命令

用法：
  {program} [选项] <节点> [command [arg...]]

参数：
  <节点>          有权限的节点 ID，或精确、唯一的节点名称。
  [command ...]   交给远端 Shell 的命令；省略时打开交互 Shell。

选项（放在节点前）：
  -h, --help       显示帮助后退出。
  -V, --version    显示 CLI 包版本后退出。

示例：
  {program} ubuntu-develop
  {program} ubuntu-develop uname -a
  {program} ubuntu-develop "echo hello && whoami"

说明：
  名称须在可访问节点中唯一（包括离线节点），重名时使用 ID。
  远程参数以空格拼接；Shell 表达式须按本机 Shell 语法引用。
  远端 --help、-h、--version 不作为本机选项处理；保留远程命令的真实退出码。
  命令以 Node 服务账号运行，不支持登录账号、提权及 -t、-p、-i 等 SSH 连接选项；无需 SSH 端口。
  建连有超时，附着后的命令没有运行时长或输出空闲超时。命令不自动重试。
  退出或连接无法恢复时关闭终端，不提供后台任务托管。

${configurationHelp}`,
    scp: `{program} — 复制普通文件

用法：
  {program} [选项] <源> <目标>

参数：
  <源>            本机文件或有权限的节点文件端点。
  <目标>          本机文件、目录或有权限的节点端点。
  节点端点：<节点>://<绝对路径> 或 <节点>:<绝对路径>。
  节点须使用 ID 或精确、唯一的名称（包括离线节点）。
  至少一端必须为节点，支持 Linux 和 Windows 路径。

选项：
  -p              保留源文件权限及访问、修改时间。
  -q              不显示进度（默认已不显示）。
  -h, --help       显示帮助后退出，须放在第一个文件端点前。
  -V, --version    显示 CLI 包版本后退出，须放在第一个文件端点前。
  --              后续参数按字面路径处理。

示例：
  {program} ./artifact.bin ubuntu-develop:///tmp/artifact.bin
  {program} ubuntu-develop:///tmp/artifact.bin ./
  {program} -p linux:///tmp/artifact.bin "windows://C:/Artifacts/"

说明：
  已有目标目录自动追加源文件名；目录路径必须已存在。
  已有普通文件默认覆盖，未使用 -p 时保留其权限。
  拒绝源目录、符号链接、接收平台不合法的文件名及最终目标目录；不支持递归 -r、多源及 SSH 连接选项。
  Server 和 Node 均须支持二进制 Terminal pipe；这不是系统 SCP。
  文件访问遵循 Node 服务账号权限。完整校验后原子发布，失败不替换原文件；
  强制终止可能留下临时文件，传输不自动重试。

${configurationHelp}`,
    version: `marctl — MyAgentRoam CLI 版本

用法：
  {program} [选项]
  marctl --version
  marctl -V

选项：
  -h, --help       显示帮助后退出。
  -V, --version    显示 CLI 包版本后退出。

示例：
  {program}
  marctl --version

输出：
  marctl <version>

读取已安装的 @myagentroam/marctl 包版本，输出单行并以换行符结尾。
该版本独立于 Node 和 Server；无需配置、授权或连接 Server。`
  }),
  nodesHeader: '节点 ID\t名称\t状态\t平台',
  connected: '在线',
  disconnected: '离线',
  errors: Object.freeze({
    sessionOutcomeUnknown: '投递结果未知，请先查看会话状态和历史，不要盲目重试。',
    sessionMessageInvalid: '消息不能为空或超过长度限制；输入文件必须是可读取的 UTF-8 文本。',
    sessionImageInvalid:
      '图片必须是可读取的 PNG、JPEG、GIF 或 WebP 文件：最多 5 张，单张 5 MiB，合计 10 MiB。',
    sessionWaitUnknown: '无法确认指定 Run，请查看会话状态和历史。',
    sessionWaitCancelled: '已取消等待，未停止目标 Run。',
    sessionWaitTimeout: '等待超时，未停止目标 Run。',
    sessionApprovalUnsupported: '此 Node 不支持待审批状态观察。',

    userContextUnavailable: '此 Node 会话没有有效的 marctl 用户授权。',
    sessionContextRequired: '当前上下文没有会话，请显式指定会话 ID。',
    serverUrlInvalid: 'MAR_CTL_SERVER_URL 无效。',
    serverUrlTransport: 'MAR_CTL_SERVER_URL 必须使用 HTTPS 或回环 HTTP。',
    serverUrlOrigin: 'MAR_CTL_SERVER_URL 必须是不含凭据或查询参数的 Origin。',
    fetchUnavailable: '当前 Node.js 运行时没有 Fetch。',
    serverInvalidNodes: 'Server 返回的节点列表无效。',
    serverInvalidManifest: 'Server 返回的节点清单无效。',
    terminalCommandInvalid: '终端命令无效。',
    terminalSequenceInvalid: '终端序列无效。',
    terminalTicketInvalid: '终端票据无效。',
    terminalIdInvalid: '终端标识无效。',
    nodeIdInvalid: '节点标识无效。',
    nodeNameAmbiguous: '多个可访问节点同名，请使用节点 ID。',
    nodeNotFound: '没有与该 ID 或名称匹配的可访问节点。',
    terminalSizeInvalid: '终端尺寸无效。',
    serverInvalidTerminalId: 'Server 返回的终端标识无效。',
    serverInvalidTicket: 'Server 返回的终端票据无效。',
    serverInvalidJson: 'Server 返回的 JSON 无效。',
    serverTimeout: 'marctl Server 未能在控制面请求超时前响应。',
    serverUnreachable: '无法连接 marctl Server。',
    serverRejected: 'marctl Server 拒绝了请求。',
    terminalConnectionStart: '无法启动终端连接。',
    terminalConnectionOpen: '无法打开终端连接。',
    terminalAttachTimeout: '终端未能在连接建立超时前完成附着。',
    terminalAttachConnection: '终端附着期间连接失败。',
    terminalAttachLost: '终端附着期间连接断开。',
    terminalRemoteError: '远程终端返回错误。',
    terminalClosedBeforeAttach: '远程终端在附着前关闭。',
    terminalFrameInvalid: '终端帧无效。',
    terminalInvalidJson: '终端返回了无效 JSON。',
    terminalBinaryFrame: '终端返回了无效二进制帧。',
    terminalConnectionFailed: '终端连接失败。',
    terminalConnectionLost: '终端连接断开。',
    terminalUnexpectedFrame: '远程终端返回了意外帧。',
    terminalInputFailed: '无法发送终端输入。',
    terminalResizeFailed: '无法发送终端尺寸。',
    terminalInteractiveRequired: '需要交互式终端。',
    terminalInteractiveInit: '无法初始化交互式终端。',
    terminalCloseFailed: '无法关闭远程终端。',
    terminalSessionFailed: '终端会话失败。',
    terminalDirectUnsafeFallback: 'OPEN 后无法安全取消直连终端，已跳过 relay 回退。',
    invalidArguments: '命令参数无效。',
    sessionDeliveryRequired: 'send 必须且只能选择 --steer 或 --queue，即使目标空闲也需指定。',
    sshOptionsUnsupported: '不支持 SSH 选项，请使用 marssh <节点>。',
    scpOptionsUnsupported: 'Node Terminal 传输不支持此 SCP 选项。',
    terminalBinaryUnavailable: '二进制复制需要支持 pipe 终端的 Server 与 Node。',
    commandFailed: '命令执行失败。'
  })
});
