export const workbenchCompositionZhCN = {
  generated: {
    workbenchEntityService: {
      leaveBlankToDisplayTheRegisteredAddress: '留空即可恢复为注册地址显示。',
      renameNode: '重命名节点',
      nodeName: '节点名称',
      nodeNameCannotExceed80Characters: '节点名称不能超过 80 个字符',
      save: '保存',
      cancel: '取消',
      unableToUpdateTheNodeName: '无法更新节点名称：{value0}',
      enterANonEmptySessionName: '请输入会话名称，不能为空。',
      renameSession: '重命名会话',
      sessionName: '会话名称',
      sessionNameCannotBeEmpty: '会话名称不能为空',
      sessionNameCannotExceed160Characters: '会话名称不能超过 160 个字符',
      save2: '保存',
      cancel2: '取消',
      unableToUpdateTheSessionName: '无法更新会话名称：{value0}',
      unableToTheSession: '无法{value0}会话：{value1}',
      unableToMoveThePinnedSession: '无法移动置顶会话：{value0}',
      thisPermanentlyDeletesTheNativeSessionAnd:
        '将永久删除“{value0}”的 {value1} 原生会话记录，且无法恢复。',
      deleteSession: '确认删除会话',
      deleteSession2: '删除会话',
      cancel3: '取消',
      theNativeSessionWasDeleted: '原生会话已删除。',
      unableToDeleteTheSession: '无法删除会话：{value0}',
      deletingDisconnectsItAndRemovesItsServer:
        '删除“{value0}”将断开连接、删除 Server 保存的凭据和节点记录。目标机器需使用新的注册密钥才能重新绑定。',
      deleteNode: '确认删除节点',
      deleteNode2: '删除节点',
      cancel4: '取消',
      nodeDeletedCreateANewRegistrationToken:
        '节点已删除；如需重新绑定，请在节点注册中创建新的注册密钥。',
      unableToDeleteTheNode: '无法删除节点：{value0}'
    },
    workbenchPresentationStateService: {
      contextWindow: '上下文窗口：{value0}',
      stopping: '正在停止 · {value0}'
    },
    workbenchPageInteractionService: {
      filePreviewIsCurrentlyUnavailable: '文件预览暂不可用。',
      copyFailedCheckTheBrowserClipboardPermission: '复制失败，请检查浏览器剪贴板权限。'
    },
    workbenchNewSessionController: {
      foldersCannotBeAttachedCompressTheFolder: '不支持拖入文件夹，请先压缩后添加附件。'
    },
    runnerUsageService: {
      usageCapabilityDetectionFailedCloseAndReopen:
        '用量查询能力检测失败；关闭并重新打开节点详情即可重试。',
      detectingUsageCapability: '正在检测用量查询能力。',
      usageQueriesRequireAnOfficialOAuthAccount:
        '仅支持通过官方账号 OAuth 登录的 Agent 查询用量；API Key 和第三方 API 服务暂不支持查询。',
      thisRunnerIsUnavailableSoUsageCannot: '当前 Agent 不可用，无法查询用量。',
      thisRunnerDoesNotCurrentlySupportUsage: '当前 Agent 暂不支持查询用量。',
      unableToQueryUsage: '无法查询用量：{value0}',
      notProvided: '未提供'
    },
    workbenchCapabilityService: {
      unableToLoadNodes: '无法读取节点：{value0}',
      unknown: '未知',
      unknown2: '未知'
    }
  },
  common: {
    ready: '可用',
    unavailable: '不可用',
    unableToPinSession: '无法置顶会话：{reason}',
    unableToUnpinSession: '无法取消置顶会话：{reason}'
  },
  workspace: {
    directory: '目录'
  },
  presentation: {
    noticeErrorPattern:
      '无法|失败|拒绝|失效|未投递|未提交|未接收|错误|failed|failure|rejected|invalid|error',
    noticeWarningPattern:
      '正在恢复|需要|不能|只读|未知|不可用|recovering|required|cannot|read-only|unknown|unavailable',
    noticeCopyPattern: '已复制|copied',
    noticeSuccessPattern: '^(?:已|saved|updated|deleted|completed|connected)'
  },
  nodeMessages: {
    fiveHourLimit: '5 小时额度',
    sevenDayLimit: '7 天额度',
    sevenDaySonnetLimit: '7 天 Sonnet 额度',
    codexUsage: 'Codex 用量',
    claudeUsage: 'Claude Code 用量'
  }
} as const;
