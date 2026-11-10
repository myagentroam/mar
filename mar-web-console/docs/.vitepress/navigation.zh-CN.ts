export const zhSidebar = [
  {
    text: '开始使用',
    items: [
      { text: 'MyAgentRoam 是什么', link: '/getting-started/overview' },
      { text: 'npm 快速开始', link: '/getting-started/npm-quick-start' },
      { text: '部署前准备', link: '/getting-started/prerequisites' },
      { text: '部署 Server 与 Web', link: '/getting-started/server-installation' },
      { text: '首次登录与修改密码', link: '/getting-started/first-login' },
      { text: '接入第一台 Node', link: '/getting-started/connect-node' },
      { text: '登记第一个 Workspace', link: '/getting-started/register-workspace' },
      { text: '开始第一次 Agent 对话', link: '/getting-started/first-agent-session' },
      { text: '接下来可以做什么', link: '/getting-started/next-steps' }
    ]
  },
  {
    text: '核心概念',
    items: [
      { text: 'Server、Node、Web 与 Runner', link: '/concepts/architecture' },
      { text: 'Node 与 Workspace', link: '/concepts/node-and-workspace' },
      { text: '会话、运行与消息队列', link: '/concepts/session-run-turn' },
      { text: 'Runner 与会话控制状态', link: '/concepts/runner-control' },
      { text: '文件、Git 与终端', link: '/concepts/files-git-terminal' },
      { text: '用户、组织与资源权限', link: '/concepts/permissions-and-sharing' },
      { text: '环境变量密钥与注入顺序', link: '/concepts/secrets' },
      { text: '数据归属、凭据与安全边界', link: '/concepts/data-and-security' }
    ]
  },
  {
    text: '工作 / 对话使用指南',
    items: [
      { text: '工作模式、Node 与 Workspace', link: '/workbench/navigation' },
      { text: '收藏与安装 Skill', link: '/workbench/skills' },
      { text: '创建、查找与管理会话', link: '/workbench/sessions' },
      { text: '发送消息与使用 Composer', link: '/workbench/composer' },
      { text: '上下文用量、Compact 与 Plan', link: '/workbench/context-and-plan' },
      { text: '@ 引用、文件夹与附件', link: '/workbench/file-reference-and-attachment' },
      { text: '阅读对话、工具调用与通知', link: '/workbench/conversation' },
      { text: '在对话模式从模板新建对话', link: '/workbench/hosted-conversations' },
      { text: '浏览、搜索与管理文件', link: '/workbench/files' },
      { text: '查看 Git Changes 与 Diff', link: '/workbench/git-changes' },
      { text: '查看 Git 历史', link: '/workbench/git-history' },
      { text: '使用 Workspace 终端', link: '/workbench/terminal' },
      { text: '在移动端继续工作', link: '/workbench/mobile' }
    ]
  },
  {
    text: 'Agent 指南',
    items: [
      { text: '选择 Agent', link: '/runners/overview' },
      { text: '安装、配置和使用 OpenCode', link: '/runners/opencode' },
      { text: '安装、配置和使用 Codex', link: '/runners/codex' },
      { text: '安装、配置和使用 Claude Code', link: '/runners/claude-code' },
      { text: '配置和使用内置 MAR Agent', link: '/runners/mar-agent' },
      { text: 'Agent 不可用或模型缺失', link: '/runners/runner-troubleshooting' }
    ]
  },
  {
    text: '部署与运维',
    items: [
      { text: '生产部署与反向代理', link: '/deployment/production' },
      { text: '安装与注册 Node', link: '/deployment/node-installation' },
      { text: 'Linux Node 与 systemd', link: '/deployment/node-linux' },
      { text: 'Windows Node 与任务计划', link: '/deployment/node-windows' },
      { text: 'macOS Node 与 launchd', link: '/deployment/node-macos' },
      { text: '升级 MyAgentRoam', link: '/deployment/upgrade' },
      { text: '备份与恢复', link: '/deployment/backup-restore' },
      { text: '网络、TLS 与 WebSocket', link: '/deployment/network' },
      { text: '上线安全检查清单', link: '/deployment/security-checklist' }
    ]
  },
  {
    text: '节点运维工具',
    items: [{ text: '使用 marctl 管理节点', link: '/operations/marctl' }]
  },
  {
    text: '管理指南',
    items: [
      { text: '账户安全与登录会话', link: '/administration/account' },
      { text: '管理 Node 与 Workspace', link: '/administration/nodes-workspaces' },
      { text: '管理对话模板', link: '/administration/conversation-templates' },
      { text: '维护对话模板 Workspace', link: '/administration/template-workspace-maintenance' },
      { text: '管理环境变量密钥', link: '/administration/secrets' },
      { text: '配置 SMTP 邮件与通知模板', link: '/administration/email-notifications' },
      { text: '管理用户、组织与角色', link: '/administration/users-organizations' },
      { text: '配置 OAuth 2.0 SSO', link: '/administration/oauth' },
      { text: '查询与导出操作审计', link: '/administration/audit' },
      { text: '社区版、企业 License 与冻结态', link: '/administration/license' }
    ]
  },
  {
    text: '故障排查与参考',
    items: [
      { text: '从现象开始排查', link: '/troubleshooting/quick-diagnosis' },
      { text: 'Node 注册失败或离线', link: '/troubleshooting/node-offline' },
      { text: 'Workspace、文件或 Git 不可用', link: '/troubleshooting/workspace-files' },
      { text: '会话卡在 Working、Idle 或只读', link: '/troubleshooting/session-run' },
      { text: '终端无法打开或频繁断线', link: '/troubleshooting/terminal' },
      { text: '键盘快捷键', link: '/reference/keyboard-shortcuts' },
      { text: '状态、提示与常见错误', link: '/reference/status-and-errors' },
      { text: '配置项参考', link: '/reference/configuration' },
      { text: '端口、配置目录与数据位置', link: '/reference/ports-paths-data' },
      { text: '版本、容量与已知限制', link: '/reference/limits' }
    ]
  }
];

export const zhDocumentationMessages = {
  description: 'MyAgentRoam 部署、配置与使用文档',
  langMenuLabel: '切换语言',
  outline: '本页内容',
  returnToTopLabel: '返回顶部',
  sidebarMenuLabel: '文档目录',
  darkModeSwitchLabel: '外观',
  lightModeSwitchTitle: '切换至浅色模式',
  darkModeSwitchTitle: '切换至深色模式',
  prev: '上一篇',
  next: '下一篇',
  search: '搜索文档'
};
