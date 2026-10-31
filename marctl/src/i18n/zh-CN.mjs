const configurationHelp = `授权：
  仅 MAR 打开的终端和普通 Workspace Agent Run 可访问节点，定时任务使用任务 owner 的权限。
  MAR 自动提供短期用户凭证；不支持外部终端或持久管理员密钥。`;

export default Object.freeze({
  help: `marctl — MyAgentRoam 命令行工具

用法：
  marctl [选项] <子命令> [参数]
  marctl help [子命令]

子命令：
  agents   查看和协调当前工作区中的会话。
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
    agents: `{program} — 协调当前 MAR 工作区中的 Agent

用法：
  {program} start [-m <text> | --message-file <file|->]
    [--runner <runner>] [--parent <id>] [--model-id <id>] [--effort <value>]
    [--title <name>] [--goal <objective> | --clear-goal]
    [--client-message-id <id>] [--json]
  {program} send <id> [-m <text> | --message-file <file|->]
    [--steer | --queue] [--goal <objective> | --clear-goal]
    [--approval <id> --decision <approve|reject>]
    [--client-message-id <id>] [--json]
  {program} wait [<id>] [--agent <id> ...] [--mode any|all]
    [--wait-for message|completion] [--timeout <duration>] [--json]
  {program} stop <id> --execution <execution-id> [--json]
  {program} list [--scope tree|active] [--query <title>]
    [--limit <1..100>] [--json]
  {program} view [<id>] [--history] [--cursor <cursor>]
    [--limit <1..100>] [--json]

管理：
  {program} config [<id>] [--model-id <id>] [--effort <value>] [--json]
  {program} rename [<id>] --title <name> [--json]
  {program} prompt get|clear [<id>] [--json]
  {program} prompt set [<id>] (-m <text> | --message-file <file|->) [--json]
  {program} schedule list [--cursor <cursor>] [--limit <1..100>] [--json]
  {program} schedule get [<id>] [--json]
  {program} schedule create [<id>] --cron <cron>
    (-m <text> | --message-file <file|->) [--json]
  {program} schedule update [<id>] --expected-revision <revision>
    [--cron <cron>] [-m <text> | --message-file <file|->] [--json]
  {program} approval decide <id> --run <run-id> --approval <approval-id>
    --decision <approve|reject> [--json]
  {program} wait <id> --run <run-id> [--until approval] --timeout <duration>
  {program} goal get|clear <id> [--json]
  {program} goal set <id> (-m <text> | --message-file <file|->) [--json]
  {program} current | show [<id>] | graph [<id>] | history [<id>]

输入与结果：
  start 默认当前会话的 Runner；没有当前会话的终端须指定 --runner 或
  --parent。start 不等待。
  send 默认追加；--steer 优先补充，--queue 排队。--goal 设置或替换目标，
  --clear-goal 清除目标；send 可仅更新目标，省略则不修改。
  stop 清除目标会话的 Goal。wait 默认等待直接子会话终态 30 秒，
  0ms 为快照；正数小于 10 秒按 10 秒等待，最多 5 分钟。等待不会停止任务。
  -m 与 --message-file 互斥；文件使用 UTF-8，- 从 stdin 读取。
  list 默认查询所在会话树，包含空闲会话；
  没有当前会话时默认 active，显式 tree 须有会话上下文。active 包含当前
  Workspace 中运行及睡眠的会话。返回 currentAgentId（无会话时为 null）、
  扁平 sessions 和 truncated。limit 默认及上限均为 100，无 cursor 或分页。
  配置和持久提示从后续执行生效。
  即时沟通或纠偏优先使用 --steer。
  建议仅将 --queue 用于明确要求延后的输入：当前工作及前面的队列项结束后才消费，
  有活动 Goal 时，必须等到该 Goal 退出才消费。已接收不保证立即处理。
  消息被接受后，通常无需另行确认收悉或立即查看是否收到。
  子会话运行时建议并行推进有意义且不重叠的工作；无其他本地工作可做，且需
  结果解除阻塞或收尾时，再考虑等待。

  show --json 包含 session.status、session.modelId、session.effort、
  session.title、session.runId、session.recentTools、session.queuedCount 和
  session.latestMessage。list 每项仅含 id、parentSessionId、title、runner 和
  status；wait 可能包含 progress；
  状态为 RUNNING/IDLE/SLEEPING。历史中 segments[].items[] 的
  kind === "assistant_message" 包含 payload.text。

退出码：1 失败，2 参数，3 授权，4 不支持，5 超时，6 结果未知，
  130 取消等待。--json 输出单个结果或错误对象。`,
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
