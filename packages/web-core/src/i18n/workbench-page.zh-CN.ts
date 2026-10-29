export const workbenchPageZhCN = {
  workbench: {
    recoverUpload: '选择中断上传的原文件',
    closeSidebar: '关闭侧滑菜单',
    closeWorkspaceTools: '关闭工作区工具'
  },
  common: { loading: '加载中…', retry: '重试', webReady: 'Web Console 已就绪' },
  navigation: {
    nodeManagement: '节点管理',
    workspaceManagement: '工作区管理',
    skillConfiguration: '技能配置',
    skillSources: '技能源管理',
    mcpSources: 'MCP 源管理',
    secrets: '环境密钥管理',
    marAgentModels: 'MAR Agent 模型',
    configuration: '系统配置',
    system: '系统信息',
    nodes: '工作',
    account: '账户安全',
    personalInstructions: '个性化提示词',
    shortcuts: '快捷键',
    about: '关于'
  },
  webUpdate: { title: '应用版本已更新', message: '发现新版本 v{value0}，点击此提示立即刷新应用。' },
  generated: {
    workbenchSurface: {
      workspaceMetadataUnavailable: '工作区信息暂不可用',
      retryWorkspace: '重试加载',
      registerWorkspace: '登记工作区',
      offlineWorkspace: '节点离线，等待重新连接。',
      selectAWorkspace: '选择一个工作区',
      selectANodeInTheResourceExplorer: '从左侧资源管理器直接打开一个已登记的工作区。',
      noNodeConnectedYetCreateARegistration:
        '还没有绑定节点？前往节点管理创建注册密钥，并在目标机器启动节点后回到这里选择。',
      openNodeManagement: '前往节点管理',
      nodeWorkbenchCapabilitiesAreUnavailable: '节点 Workbench 能力不可用。',
      openAWorkspace: '打开一个工作区',
      selectAWorkspaceOnTheCurrentNode: '从左侧资源管理器打开工作区，或切换已打开的标签。',
      agentConversation: 'Agent 对话',
      run: '执行 /{value0}',
      typeForCommandsToReferenceWorkspaceFiles:
        "输入 / 调用命令、# 使用快捷提示词、用 {'@'} 提及工作区文件、文件夹或会话，或添加附件，向 {value0} 提问…",
      readOnlyInspector: '只读检查器',
      workspace: '工作区'
    },
    workbenchSelectionStateService: { unknown: '未知' },
    workbenchPageController: {
      noNodeSelected: '未选择节点',
      theNodeIsDisabledOnlyTheCurrent: '节点已禁用；当前内容仅供查看，无法继续同步。',
      theNodeIsOfflineLoadedContentIs: '节点离线，已读取的内容只读且不会发起控制操作。',
      nodeWorkbenchCapabilitiesAreUnknownTheWorkspace:
        '节点 Workbench 能力未知，已安全降级为只读。',
      nodeWorkbenchCapabilitiesAreUnavailable: '节点 Workbench 能力不可用：{value0}。',
      unableToOpenTheSessionLinkedTo: '无法打开通知关联会话：{value0}',
      aNewerInstanceWithTheSameIdentity:
        '当前节点已被同一身份的新实例接管，终端和未持久化运行状态可能已重置。',
      receivedAnUnreadableLiveUpdate: '收到无法读取的实时更新。',
      unknown: '未知',
      unableToCreateARegistrationToken: '无法创建注册密钥：{value0}',
      createANewSessionBranchBeforeThis:
        '将从此用户消息之前创建新会话分支，并回填该消息。原会话和工作区文件不会改变。',
      createANewSessionBranchThatRetains:
        '将保留此 Agent 消息所在的完整对话轮次并创建新会话分支。原会话和工作区文件不会改变。',
      createFallbackBranch: '创建回退分支',
      createBranch: '创建分支',
      cancel: '取消',
      fallbackBranchCreated: '已创建回退分支。',
      fallbackBranchCreatedButLoadFailed: '回退分支已创建，但无法打开：{value0}',
      rollbackCompletedButLoadFailed: '对话已回滚，但无法重新加载：{value0}',
      unableToCreateAFallbackBranch: '无法创建回退分支：{value0}',
      rollbackConversationWarning:
        '此操作会在当前会话中永久删除这条用户消息及其后的全部对话记录。工作区文件不会回滚，该消息将回填到输入框。',
      rollbackConversation: '回滚对话',
      confirmRollbackConversation: '确认回滚',
      unableToRollbackConversation: '无法回滚对话：{value0}'
    }
  }
} as const;
