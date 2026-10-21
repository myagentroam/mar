export const enSidebar = [
  {
    text: 'Getting Started',
    items: [
      { text: 'What Is MyAgentRoam?', link: '/en-US/getting-started/overview' },
      { text: 'Before You Deploy', link: '/en-US/getting-started/prerequisites' },
      { text: 'Deploy Server and Web', link: '/en-US/getting-started/server-installation' },
      { text: 'First Sign-in and Password Change', link: '/en-US/getting-started/first-login' },
      { text: 'Connect Your First Node', link: '/en-US/getting-started/connect-node' },
      { text: 'Register Your First Workspace', link: '/en-US/getting-started/register-workspace' },
      {
        text: 'Start Your First Agent Session',
        link: '/en-US/getting-started/first-agent-session'
      },
      { text: 'Next Steps', link: '/en-US/getting-started/next-steps' }
    ]
  },
  {
    text: 'Core Concepts',
    items: [
      { text: 'Server, Node, Web, and Runner', link: '/en-US/concepts/architecture' },
      { text: 'Nodes and Workspaces', link: '/en-US/concepts/node-and-workspace' },
      { text: 'Sessions, Runs, and Message Queues', link: '/en-US/concepts/session-run-turn' },
      { text: 'Runners and Session Control', link: '/en-US/concepts/runner-control' },
      { text: 'Files, Git, and Terminals', link: '/en-US/concepts/files-git-terminal' },
      { text: 'Users, Organizations, and Access', link: '/en-US/concepts/permissions-and-sharing' },
      { text: 'Secrets and Injection Order', link: '/en-US/concepts/secrets' },
      { text: 'Data, Credentials, and Security', link: '/en-US/concepts/data-and-security' }
    ]
  },
  {
    text: 'Work / Conversation Guide',
    items: [
      { text: 'Work Mode, Nodes, and Workspaces', link: '/en-US/workbench/navigation' },
      { text: 'Favorite and Install Skills', link: '/en-US/workbench/skills' },
      { text: 'Create and Manage Sessions', link: '/en-US/workbench/sessions' },
      { text: 'Messages and Composer', link: '/en-US/workbench/composer' },
      { text: 'Context, Compact, and Plan', link: '/en-US/workbench/context-and-plan' },
      {
        text: 'References, Folders, and Attachments',
        link: '/en-US/workbench/file-reference-and-attachment'
      },
      { text: 'Conversations, Tools, and Notifications', link: '/en-US/workbench/conversation' },
      {
        text: 'Start a Template Conversation in Conversation Mode',
        link: '/en-US/workbench/hosted-conversations'
      },
      { text: 'Browse, Search, and Manage Files', link: '/en-US/workbench/files' },
      { text: 'Git Changes and Diff', link: '/en-US/workbench/git-changes' },
      { text: 'Git History', link: '/en-US/workbench/git-history' },
      { text: 'Workspace Terminals', link: '/en-US/workbench/terminal' },
      { text: 'Continue on Mobile', link: '/en-US/workbench/mobile' }
    ]
  },
  {
    text: 'Agent Guide',
    items: [
      { text: 'Choose OpenCode, Codex, or Claude Code', link: '/en-US/runners/overview' },
      { text: 'OpenCode', link: '/en-US/runners/opencode' },
      { text: 'Codex', link: '/en-US/runners/codex' },
      { text: 'Claude Code', link: '/en-US/runners/claude-code' },
      { text: 'Built-in MAR Agent', link: '/en-US/runners/mar-agent' },
      { text: 'Runner Troubleshooting', link: '/en-US/runners/runner-troubleshooting' }
    ]
  },
  {
    text: 'Deployment and Operations',
    items: [
      { text: 'Production Deployment and Reverse Proxy', link: '/en-US/deployment/production' },
      { text: 'Install and Register a Node', link: '/en-US/deployment/node-installation' },
      { text: 'Linux Node and systemd', link: '/en-US/deployment/node-linux' },
      { text: 'Windows Node and Task Scheduler', link: '/en-US/deployment/node-windows' },
      { text: 'macOS Node and launchd', link: '/en-US/deployment/node-macos' },
      { text: 'Upgrade MyAgentRoam', link: '/en-US/deployment/upgrade' },
      { text: 'Backup and Restore', link: '/en-US/deployment/backup-restore' },
      { text: 'Network, TLS, and WebSocket', link: '/en-US/deployment/network' },
      { text: 'Production Security Checklist', link: '/en-US/deployment/security-checklist' }
    ]
  },
  {
    text: 'Node Operations Tools',
    items: [{ text: 'Manage Nodes with marctl', link: '/en-US/operations/marctl' }]
  },
  {
    text: 'Administration Guide',
    items: [
      { text: 'Account Security and Sign-in Sessions', link: '/en-US/administration/account' },
      { text: 'Manage Nodes and Workspaces', link: '/en-US/administration/nodes-workspaces' },
      {
        text: 'Manage Conversation Templates',
        link: '/en-US/administration/conversation-templates'
      },
      {
        text: 'Maintain a Conversation Template Workspace',
        link: '/en-US/administration/template-workspace-maintenance'
      },
      { text: 'Manage Secrets', link: '/en-US/administration/secrets' },
      {
        text: 'Configure SMTP Email and Notification Templates',
        link: '/en-US/administration/email-notifications'
      },
      {
        text: 'Manage Users, Organizations, and Roles',
        link: '/en-US/administration/users-organizations'
      },
      { text: 'Configure OAuth 2.0 SSO', link: '/en-US/administration/oauth' },
      { text: 'Audit Events and Export', link: '/en-US/administration/audit' },
      { text: 'Personal and Enterprise Licenses', link: '/en-US/administration/license' }
    ]
  },
  {
    text: 'Troubleshooting and Reference',
    items: [
      { text: 'Quick Diagnosis', link: '/en-US/troubleshooting/quick-diagnosis' },
      { text: 'Node Registration or Offline Issues', link: '/en-US/troubleshooting/node-offline' },
      { text: 'Workspace, File, or Git Issues', link: '/en-US/troubleshooting/workspace-files' },
      { text: 'Session Stuck or Read-only', link: '/en-US/troubleshooting/session-run' },
      { text: 'Terminal Connection Issues', link: '/en-US/troubleshooting/terminal' },
      { text: 'Keyboard Shortcuts', link: '/en-US/reference/keyboard-shortcuts' },
      { text: 'Statuses and Common Errors', link: '/en-US/reference/status-and-errors' },
      { text: 'Configuration Reference', link: '/en-US/reference/configuration' },
      { text: 'Ports, Paths, and Data', link: '/en-US/reference/ports-paths-data' },
      { text: 'Versions, Capacity, and Limits', link: '/en-US/reference/limits' }
    ]
  }
];
