export const composerZhCN = {
  composerReference: {
    picker: '引用文件或会话',
    file: '文件',
    session: '会话',
    fileUnavailable: '文件搜索不可用。',
    enterPath: '输入路径以搜索文件和文件夹。',
    fileError: '文件搜索失败，请修改关键词后重试。',
    sessionLoading: '正在搜索会话…',
    sessionUnavailable: '会话搜索不可用。',
    sessionError: '会话搜索失败，请修改关键词后重试。',
    noSessions: '没有匹配的会话。',
    refine: '还有更多结果，请细化关键词。'
  },
  composerSend: {
    steer: '插入消息',
    holdHint: '上滑插入消息，越过输入框顶部取消。',
    holdSendHint: '上滑后松手发送，越过输入框顶部取消。',
    slideToSteer: '上滑插入消息 · 越过输入框顶部取消',
    releaseToSteer: '松手插入消息 · 越过输入框顶部取消',
    releaseToSend: '松手发送 · 越过输入框顶部取消',
    releaseToCancel: '松手取消'
  },
  quickPrompts: {
    loadFailed: '读取快捷提示词失败，请重试。',
    noMatches: '没有匹配的快捷提示词。',
    picker: '快捷提示词'
  },
  goal: {
    title: '目标',
    view: '查看',
    edit: '编辑',
    clear: '移除',
    update: '更新',
    cancel: '取消',
    detailsTitle: '目标详情',
    objectiveLabel: '任务目标',
    turnsLabel: '已执行轮次',
    revisionLabel: '目标修订',
    alreadyActive: '已在目标模式下。',
    removedSummary: '已移除目标，当前执行未中断。累计耗时 {value0}，已开始 {value1} 轮。',
    stoppedSummary: '已停止运行并移除目标。累计耗时 {value0}，已开始 {value1} 轮。'
  },
  runnerProfiles: {
    marAgentAccessAutoLabel: '自动',
    marAgentAccessAuto:
      '自动推进已授权工作；重要风险或授权仍不明确时询问。不提供沙箱或独立安全审查。',
    marAgentAccessFullLabel: '完全访问',
    codexAccessOnRequestLabel: '按需确认',
    codexAccessWorkspaceWriteLabel: '工作区写入',
    codexAccessFullLabel: '完全访问',
    codexAccessReadOnlyLabel: '只读',
    claudeAccessDefaultLabel: '默认',
    claudeAccessAcceptEditsLabel: '接受编辑',
    claudeAccessBypassLabel: '跳过权限确认',
    planModeLabel: '计划模式',
    openCodeAccessDefaultLabel: '默认',
    openCodeAccessAutoLabel: '自动批准',
    marAgentAccessFull: '工具不逐次请求 Agent 确认；Host 校验仍然生效，且不提供 Agent 沙箱。',
    marAgentCompact: '立即压缩当前会话上下文。',
    marAgentPlan: '开启或关闭协作规划模式。',
    marAgentClear: '永久清空当前会话历史，并保留该会话。',
    codexAccessOnRequest: '由 Codex 在需要额外权限时请求确认。',
    codexAccessWorkspaceWrite: '允许 Codex 在当前工作区内写入文件。',
    codexAccessFull: '允许 Codex 以完整权限运行，且不再逐项确认。',
    codexAccessReadOnly: '限制 Codex 为只读沙箱。',
    codexCompact: '立即压缩当前会话上下文。',
    codexPlan: '开启或关闭协作规划模式。',
    codexFast: '开启或关闭当前模型可用的快速服务层。',
    claudeAccessDefault: '按 Claude Code 默认规则确认危险操作。',
    claudeAccessAcceptEdits: '自动接受当前工作区内的文件编辑。',
    claudeAccessBypass: '跳过 Claude Code 的权限确认。',
    claudeAccessPlan: '以 Claude Code 的计划模式使用只读工具探索并制定计划，不修改源文件。',
    claudeCompact: '由 Claude Agent SDK 在当前会话中压缩上下文。',
    claudePlan: '开启或关闭标签式规划模式，只读规划并输出计划卡。',
    openCodeAccessDefault: '按 OpenCode 和当前工作区配置确认权限。',
    openCodeAccessAuto: '自动允许 OpenCode 请求的工具权限。',
    openCodeCompact: '通过 OpenCode 压缩当前会话上下文。',
    openCodePlan: '开启或关闭 OpenCode 原生 Plan Agent。',
    goal: '进入目标模式。'
  },
  common: {
    loading: '正在加载',
    runner: 'Agent',
    fast: '快速',
    reasoning: '推理',
    model: '模型',
    marAgent: 'MAR Agent',
    codex: 'Codex',
    claudeCode: 'Claude Code',
    openCode: 'OpenCode'
  },
  nodeMessages: {
    planDetail: '后续消息将以只读计划模式运行并输出计划卡。',
    implement: '执行计划',
    implementPrompt: '请执行上述计划。'
  },
  composer: {
    quote: '引用',
    previewQuote: '预览引用：{name}',
    expandQuote: '展开引用',
    collapseQuote: '收起引用',
    selectAll: '全选',
    removeQuote: '移除引用 {name}',
    quoteAssistant: '回复片段',
    quoteStreaming: '生成中片段',
    quoteHistory: '历史版本',
    quoteToolChange: '当次修改',
    quoteWorkingTree: '工作区版本',
    quoteUnsaved: '未保存编辑',
    quoteTooLarge: '无法加入引用，请缩小选区或移除部分引用。',
    skillUnavailableToken: '技能 {name} 已不可用，点击删除',
    removeSkill: '移除技能 {name}',
    removeFileReference: '移除文件引用 {name}',
    removeSessionReference: '移除会话引用 {name}',
    skillUnavailable: '所选技能已不可用，请删除后重试。'
  },
  generated: {
    composerAttachments: {
      directTransport: '局域网直连',
      serverTransport: 'Server 中继',
      serverFallbackTransport: 'Server 中继',
      enlargeAttachment: '放大查看附件 {value0}',
      enlarge: '放大查看 {value0}',
      uploading: '上传中…',
      uploading2: '上传中',
      uploaded: '已上传',
      uploadFailed: '上传失败',
      removeAttachment: '移除附件 {value0}',
      removeAttachment2: '移除附件 {value0}'
    },
    composerCommandPicker: {
      loadingRunnerCommands: '正在加载 Agent 命令…',
      runnerCommandsFailedToLoadTypeAgain: 'Agent 命令加载失败，请重新输入 / 重试。',
      loadingSkills: '正在加载技能…',
      skillsFailedToLoadTypeAgain: '技能加载失败，请重新输入 / 重试。',
      noAvailableCommandsOrSkills: '当前没有可用的命令或技能。',
      thisRunnerHasNoAvailableSlashCommands: '当前 Agent 没有可执行的 Slash Command。',
      commandsAndSkills: '命令与技能',
      runnerCommands: '命令',
      skills: '技能'
    },
    composerQueue: {
      pendingWork: '待执行工作',
      goalType: '目标',
      queueType: '队列 {position}',
      paused: '已暂停',
      save: '保存',
      edit: '编辑',
      runNow: '执行',
      moveUp: '上移',
      moveDown: '下移',
      delete: '移除'
    },
    composerToolbar: {
      addAttachment: '添加附件',
      addAttachment2: '添加附件',
      fastModeIsEnabled: 'Fast Mode 已开启',
      modelAndReasoningEffort: '模型与思考强度',
      access: '权限',
      viewContextUsageClickToCompactContext: '点击压缩上下文',
      compactUnavailable: '当前无法压缩上下文。',
      enterToQueueCtrlEnterToStop: '{send} 排队 · {steer} 插入消息',
      enterToSendShiftAltEnterFor: '{send} 发送 · Shift/Alt + Enter 换行',
      stopRun: '停止运行',
      stopping: '正在停止',
      stopRunEsc: '停止运行（{stop}）',
      send: '发送',
      send2: '发送'
    },
    conversationComposer: {
      message: '输入消息'
    },
    conversationDomain: {},
    workbenchSessionMessageService: {
      enterAMessageWhenAttachingFiles: '附加文件时需要填写消息。',
      attachmentsAreStillUploadingOrFailedWait: '附件仍在上传或上传失败，完成后才能发送。',
      sendARegularMessageToCreateThe: '请先发送一条普通消息以创建会话，再执行此命令。',
      selectAWorkspaceBeforeSendingAMessage: '请先选择工作区，再发送消息。',
      unableToSendTheMessage: '无法发送消息：{value0}',
      clearSessionConfirmation:
        '此操作会永久清空当前会话中的全部对话历史和上下文，但会保留会话标题与配置。是否继续？',
      clearSession: '清空会话',
      confirmClearSession: '清空会话',
      cancelClearSession: '取消'
    },
    workspaceQueueService: {
      theQueueOrderChangedTryAgain: '队列顺序已变化，请重试：{value0}',
      unableToReorderTheQueuedMessages: '无法调整队列顺序：{value0}',
      unableToEditTheQueuedMessage: '无法编辑队列消息：{value0}',
      unableToDeleteTheQueuedMessage: '无法删除队列消息：{value0}',
      unableToRunTheQueuedMessageNow: '无法立即执行队列消息：{value0}'
    },
    conversationUserInputService: {
      answerEveryQuestionBeforeSubmitting: '请先回答所有问题。',
      answersWereNotSubmitted: '回答未提交：{value0}'
    },
    workbenchApprovalService: { approvalWasNotSubmitted: '审批未提交：{value0}' },
    workbenchRunnerChannelService: {
      theMessageWasAddedToTheCurrent: '消息已插入当前 Claude Turn。',
      theMessageWasNotDeliveredToThe: '消息未送达当前 Claude Turn。',
      unableToSendThroughTheClaudeChannel: 'Claude 通道发送失败：{value0}'
    },
    workbenchContextCommandService: {
      compactOlderContextToFreeWindowSpace:
        '将压缩较早的上下文以释放窗口空间；此操作会保留近期对话和必要摘要。是否继续？',
      compactContext: '压缩上下文',
      compact: '压缩',
      cancel: '取消',
      unableToCompactContext: '无法压缩上下文：{value0}'
    },
    workbenchPlanService: { unableToImplementThePlan: '无法实施计划：{value0}' },
    workbenchRunControlService: {
      runOperationDenied: '运行操作被拒绝：{value0}',
      runOperationDenied2: '运行操作被拒绝：{value0}'
    },
    composerAttachmentService: {
      theFirstMessageCanIncludeUpTo: '首条消息最多附加 5 个文件。',
      attachmentMustBeLargerThan0And: '附件“{value0}”必须大于 0 且不超过 5 MiB。',
      totalAttachmentSizeCannotExceed10MiB: '附件总大小不能超过 10 MiB。',
      selectAnOnlineWorkspaceBeforeAddingAttachments: '请先选择在线工作区后再添加附件。'
    },
    runnerProfileService: {
      unableToSaveTheNodeDefaultSession: '无法保存节点默认会话配置：{value0}'
    },
    workbenchComposerController: {
      unableToUpdateTheSessionConfiguration: '无法更新会话配置：{value0}'
    }
  }
} as const;
