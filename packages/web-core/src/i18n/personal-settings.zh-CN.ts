export const personalSettingsZhCN = {
  modelUsage: {
    pagination: '用量明细分页',
    updateRecords: '更新明细',
    recordsSnapshot: '明细未自动更新，保留当前浏览内容。',
    refreshDelayed: '刷新暂不可用，稍后自动重试',
    refreshed: '上次刷新：{time}',
    overviewScope: '当前统计项 · 不受下方筛选影响',
    title: '个人用量',
    refresh: '刷新',
    last24Hours: '最近 24 小时',
    last7Days: '最近 7 天',
    tokens: 'Token',
    input: '输入',
    output: '输出',
    cache: '缓存',
    cacheWithRate: '{tokens} ({rate})',
    requests: '调用数',
    range: '时间范围',
    custom: '自定义范围',
    from: '开始时间',
    to: '结束时间',
    runner: 'Runner',
    model: '模型',
    all: '全部',
    mode: '模式',
    purpose: '用途',
    trend: '用量趋势',
    selected:
      '筛选用量：输入 {input} · 缓存 {cache} · 输出 {output} · 总 Token {tokens} · {requests} 次调用',
    timeZone: '时区：{zone}',
    empty: '所选范围内没有已采集的请求。',
    unknown: '未知',
    chartData: '查看图表数据',
    time: '时间',
    inputTokens: '输入 Token',
    outputTokens: '输出 Token',
    totalTokens: '总 Token',
    distribution: '用量分布',
    metric: '统计指标',
    runners: '按 Runner',
    models: '按模型',
    records: '用量明细',
    recordsHint: '按结束时间倒序分页；列排序仅作用于当前页。',
    requestedModel: '请求模型',
    actualModel: '实际返回模型',
    sessionId: '会话 ID',
    runId: '执行 ID',
    requestId: '请求 ID',
    responseId: '响应 ID',
    cacheReadTokens: '缓存读取 Token',
    cacheWriteTokens: '缓存写入 Token',
    reasoningTokens: '推理 Token',
    coverageLabel: '采集范围',
    state: '状态',
    loading: '正在读取用量…',
    retry: '用量读取失败，请点击刷新重试。',
    invalidRange: '请选择不晚于当前时间、长度不超过 90 天的有效时间范围。',
    runnerNames: {
      'mar-agent': 'MAR Agent',
      codex: 'Codex',
      'claude-code': 'Claude Code',
      opencode: 'OpenCode'
    },
    modes: {
      work: '工作',
      conversation: '对话'
    },
    purposes: {
      conversation: '对话请求',
      compact: '上下文压缩',
      title: '标题生成',
      prompt_completion: '输入预测',
      other: '其他模型请求'
    },
    states: {
      running: '进行中',
      succeeded: '成功',
      failed: '失败',
      cancelled: '已取消',
      interrupted: '已中断'
    },
    coverages: {
      request: '请求级用量',
      partial: '部分可观测'
    },
    roles: {
      root: '主任务',
      subagent: '子任务'
    }
  },
  shortcutGroups: {
    workspace: '工作区与全局',
    files: '文件与预览',
    editing: '查找与编辑',
    composer: '消息与队列'
  },
  keyboardShortcuts: {
    platformHint:
      'macOS 的工作区和文件快捷键请将 Ctrl 换为 Command、Alt 换为 Option；工作区 Ctrl+Tab、Ctrl+W 系列及消息输入框和队列的 Ctrl+Enter 仍使用 Control。',
    openNotificationCenter: '全局：打开或关闭通知中心',
    cycleWorkspaceTabs: '工作区：切换到前一个或后一个标签（首尾循环）',
    cycleWorkspaceTabsWithCtrlTab: '工作区：切换到下一个或前一个标签（首尾循环）',
    selectWorkspaceTab: '工作区：按序号切换标签（0 表示第十个）',
    openNewSession: '工作区：新建会话',
    closeWorkspaceTab:
      '工作区：关闭当前非固定标签（Composer 内也生效；其他输入框、终端或弹窗除外）',
    closeAllWorkspaceTabs:
      '工作区：关闭全部非固定标签（Composer 内也生效；其他输入框、终端或弹窗除外）',
    openMarkdownPreview: 'Markdown/HTML 文件预览：在独立窗口打开渲染预览',
    quickOpenWorkspaceFile: '工作区：快速打开',
    openGitChanges: '工作区：切换检查器至 Git 变更',
    searchWorkspaceContent: '工作区：搜索文件内容',
    findInPreview: '文本文件预览或 Diff：查找当前内容',
    selectEditorContent: '文本编辑：全选当前内容',
    toggleFileEditing: '文本文件或 Diff：切换编辑/只读，或打开文本标签',
    previousPreviewLocation: '文件预览：返回上一个访问位置',
    nextPreviewLocation: '文件预览：前进到下一个访问位置',
    replaceInEditor: '文本编辑：打开查找与替换',
    saveEditor: '文本编辑：保存当前文件',
    openEditorSymbols: '文本文件预览：打开当前文件的符号表',
    focusWorkspaceTerminal: '工作区：展开或收起当前选中的终端',
    openComposerModelMenu: '消息输入框：打开模型菜单',
    sendMessage: '消息输入框：发送消息',
    composerNewline: '消息输入框：插入换行',
    replaceRunningMessage: '消息输入框：停止当前任务并优先发送消息',
    stopRun: '消息输入框：停止当前任务',
    openFileReferences: '消息输入框：打开文件与文件夹引用列表',
    openAgentCommands: '消息输入框：打开当前 Agent 的可用命令',
    saveQueuedMessage: '队列编辑：保存修改',
    runQueuedMessage: '队列编辑：执行修改后的消息',
    closeFileTab: '文件标签：关闭当前标签',
    modelMenuGroup: '模型菜单：切换模型与推理强度分组',
    openCompanionPreview: '文件树或会话文件链接：在独立预览窗口打开',
    quickOpenNavigation: '快速打开：选择并打开工作区、会话、符号或文件，或关闭浮层',
    quickOpenSeparatePreview: '快速打开：在独立预览窗口打开选中的符号或文件',
    fileTabNavigation: '文件标签：在标签间移动，或跳到首尾',
    findMatchNavigation: '内嵌查找：跳到下一个或上一个匹配项',
    closeEmbeddedFind: '内嵌查找：关闭查找栏',
    closeStandalonePreview: '独立文件预览：请求关闭窗口'
  },
  common: {
    language: '语言',
    localeUpdateFailed: '语言偏好保存失败，请重试。'
  },
  settings: {
    about: '关于',
    version: '版本',
    documentation: '帮助文档',
    openDocumentation: '打开文档中心',
    thirdPartyOpenSourceSoftware: '第三方开源软件及许可声明',
    viewThirdPartyNotices: '查看 Web 第三方许可声明',
    thirdPartySummary: '以下为产品全栈采用的主要开源组件，不是完整依赖清单。',
    thirdPartyGroups: {
      web: {
        title: 'Web 界面',
        components:
          'Vue · Element Plus · Vue I18n · xterm.js · Vue Office · markdown-it · markdown-it-task-lists · highlight.js · CodeMirror · Lezer · Mermaid · PDF.js · DOMPurify · GitHub Markdown CSS'
      },
      server: {
        title: 'Server 服务',
        components: 'Fastify · mysql2 · Nodemailer · Web Push · ws · Undici · Zod'
      },
      execution: {
        title: 'Node 与 MAR Agent',
        components:
          'node-pty · node-datachannel · Playwright · QuickJS / quickjs-emscripten · MCP SDK'
      },
      tools: {
        title: '随包工具',
        components: 'ripgrep · Universal Ctags'
      },
      icons: {
        title: '图标资源',
        components:
          'Visual Studio Code Seti File Icon Theme · Material Design Icons · Material Icon Theme'
      },
      computerUse: {
        title: 'Computer Use（可选，依平台提供）',
        components: 'Python · PyAutoGUI · Pillow · PyObjC'
      }
    },
    thirdPartyDistributionNotices:
      'Server、Node 与可选运行时的许可和声明请查看对应发行包。外部 Agent、SDK 与单独安装的工具仍适用各自条款。',
    appearance: '外观',
    appearanceSummary:
      '主题、图标主题、语言和文件默认打开方式只保存在当前浏览器，终端保持固定深色配色。',
    theme: '主题',
    light: '浅色',
    dark: '暗色',
    iconTheme: '图标主题',
    defaultFileMode: '文件默认打开方式',
    fileModeEdit: '编辑',
    fileModeReadOnly: '只读'
  },
  quickPrompts: {
    title: '快捷提示词',
    summary: '输入 #短语即可在消息输入框插入对应提示词。',
    add: '新增提示词',
    edit: '编辑',
    remove: '删除',
    phrase: '短语',
    phraseHint: '例如：review',
    prompt: '提示词（Prompt）',
    empty: '还没有快捷提示词。',
    phraseRequired: '请输入短语。',
    phraseInvalid: '短语不能包含空白字符或 #，且最多 80 个字符。',
    promptRequired: '请输入提示词。',
    saved: '快捷提示词已保存。',
    saveFailed: '保存快捷提示词失败：{value0}',
    removeConfirmation: '删除“{value0}”后将无法恢复，是否继续？',
    removed: '快捷提示词已删除。',
    removeFailed: '删除快捷提示词失败：{value0}'
  },
  personalInstructions: {
    title: '个性化提示词',
    scopeHelp:
      '为当前账号配置后续 Agent 执行时的额外指引。执行时会自动合并公共提示词和当前 Agent 专属提示词，不会修改工作区或节点上的 AGENTS.md、CLAUDE.md。',
    common: '公共',
    codex: 'Codex',
    claudeCode: 'Claude Code',
    openCode: 'OpenCode',
    marAgent: 'MAR Agent',
    prompt: '个性化提示词',
    placeholder: '请输入该范围的个性化提示词',
    promptRequired: '请输入个性化提示词。',
    promptInvalid: '个性化提示词最多 20,000 个字符。',
    loadFailed: '读取个性化提示词失败，请重试。',
    saved: '个性化提示词已保存。',
    saveFailed: '保存个性化提示词失败：{value0}',
    clear: '清空',
    clearConfirmation: '清空当前范围的个性化提示词？',
    cleared: '个性化提示词已清空。',
    clearFailed: '清空个性化提示词失败：{value0}'
  },
  generated: {
    settingsContent: {
      accountSecurity: '账户安全',
      currentAccountAdminUpTo5Devices:
        '当前账号：admin。最多允许 5 个终端同时登录；密码修改会撤销既有登录状态。',
      signInSessions: '登录会话',
      signInSessions5: '登录会话（{value0}/5）',
      refreshSignInSessions: '刷新登录会话',
      noActiveSignInSessions: '暂无活跃登录会话。',
      currentDevice: '当前设备',
      signedInDevice: '已登录设备',
      signedIn: '登录于',
      expires: '有效至',
      signOut: '注销',
      confirmSignOutSession: '确认注销此登录会话？',
      changePassword: '修改密码',
      signOut2: '退出登录',
      confirmSignOut: '确认退出登录？',
      changePassword2: '修改密码',
      currentPassword: '当前密码',
      enterCurrentPassword: '请输入当前密码',
      currentPassword2: '当前密码',
      newPassword: '新密码',
      enterNewPassword: '请输入新密码',
      newPassword2: '新密码',
      confirmNewPassword: '再次输入新密码',
      enterTheNewPasswordAgain: '请再次输入新密码',
      confirmNewPassword2: '再次输入新密码',
      cancel: '取消',
      confirmChange: '确认修改',
      nodeRegistration: '节点注册',
      createAOneTimeTokenThenComplete: '创建注册密钥后，在目标设备上完成节点注册。',
      viewNodeDeploymentAndAutoStartGuide: '查看节点部署与自启动说明',
      createOneTimeNodeRegistrationToken: '创建注册密钥',
      keyboardShortcuts: '快捷键',
      theFollowingShortcutsAreAvailableInThe: '以下快捷键在当前工作台可用。'
    }
  }
} as const;
