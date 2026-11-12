export const cliMessagesZhCN = {
  quickUsage:
    '用法: mar-server setup [--config 路径] [--no-node] [--no-searxng]\n      mar-server run [--config 路径]',
  quickInvalidArguments: '参数无效，请使用 mar-server --help 查看帮助。',
  quickNetworkInvalid:
    'MAR_PUBLIC_ORIGIN 必须是 HTTP 或 HTTPS Origin，不含账号密码、路径、查询参数或片段（QUICK_START_NETWORK_INVALID）。',
  quickExternalDatabaseUnsupported: 'Quick Start 仅使用自己的 MySQL，不接受 MAR_DATABASE_URL。',
  quickSetupRequired: 'Quick Start 尚未初始化，请先执行 mar-server setup。',
  quickSetupComplete: '初始化完成。数据目录：{path}。请执行 mar-server run。',
  quickStarted: 'Server 已在 {url} 监听。数据目录：{path}。启动 Agent 前请先配置模型。',
  quickNodeNotPrepared:
    'Server 的 Node 依赖不可用，请检查 npm 安装或使用 --no-node 禁用本机 Node。',
  quickNodeInstallFailed: '本机 Node 操作失败（{code}）。请检查 Node 日志与配置。',
  quickNodeOnline: '本机 Node 已上线。',
  quickNodeBootstrapRecoveryRequired:
    '无法安全恢复本机 Node 注册（QUICK_START_NODE_BOOTSTRAP_RECOVERY_REQUIRED）：令牌已使用或状态不明，未重复登记。请保留 node-data/node.json，从备份恢复已有身份，或核对并处理上次登记后再注册。',
  quickNodeUnavailable: '本机 Node 尚未上线。请检查 Node 日志与配置；注册不会自动重试。',
  quickNodeSupervisorExited: '本机 Node Supervisor 意外退出。管理页面仍可访问，请检查 Node 日志。',
  quickSearchDisabled: '此平台无法使用本地搜索，已禁用；之后可配置外部搜索地址。',
  quickSearchUnavailable: '外部搜索地址未通过 JSON 搜索检查，本次运行已禁用客户端搜索。',
  quickManagedSearchReady: '本地搜索可用。',
  quickManagedSearchUnavailable:
    '本地搜索不可用，其他组件仍可使用；请重试 setup 或配置外部搜索地址。',
  quickManagedSearchFailure:
    '本地搜索准备失败（{code}），其他组件仍可使用；请重试 setup 或配置外部搜索地址。',
  quickFailed: 'Quick Start 失败：{code}。',
  quickReclaimFailed:
    '无法确认受管进程已停止（{code}），部署锁已保留。恢复前请确认本部署的进程均已停止；归属不明确时不要删除锁。',
  quickPortInUse: 'Server 端口已被占用。请修改 Quick Start 配置中的 serverPort 后重新运行。',
  splitBaselineUsage: '用法: prepare-server-split-baseline.mts --check | --sql',
  splitBaselineValid:
    '源数据库已通过离线拆分预检。请保持所有写入方停服；输出 SQL 不会执行任何修改。',
  licenseUsage: '用法: license <keygen|fingerprint|issue|inspect|verify> [--参数 值]',
  licenseKeyWritten: '私钥已写入 {destination}，请将上方公钥更新到 Server 发布配置。',
  resetPasswordRequired: '请通过 MAR_RESET_PASSWORD 提供新的管理员密码。',
  resetPasswordCompleted: '管理员密码已重置，下一次登录后必须修改密码。'
} as const;
