export const workspaceZhCN = {
  sessionGroups: {
    label: '会话分组',
    main: '主会话',
    child: '子会话',
    mainTab: '主会话',
    childTab: '子会话',
    unread: '未读',
    running: '运行 {count} 个会话',
    emptyMain: '暂无主会话',
    emptyChild: '暂无子会话',
    noResults: '没有匹配的会话',
    move: '移动到主会话',
    confirm: '移动',
    cancel: '取消',
    description:
      '仅清除此会话与父会话的分组关系，并移动到“主会话”。会话历史、运行任务和队列不受影响；其子会话的关系不变。',
    moved: '已移动到主会话',
    failed: '无法移动会话：{reason}'
  },
  generated: {
    sessionPrompt: {
      title: '会话提示词',
      description:
        '在本会话的个人提示词之后追加。从下一次执行开始生效，包括排队消息和 Goal 续作；不会删除对话历史中已有的旧指令。',
      placeholder: '输入此会话专用的指令；留空并保存可清除。',
      tooLong: '会话提示词不能超过 20000 个字符。',
      cancel: '取消',
      save: '保存'
    },
    workspaceRegistrationPicker: {
      enterADirectoryName: '请输入目录名称',
      enterASingleDirectoryNameWithoutPath: '请输入不含路径分隔符的单级目录名称',
      registerANewWorkspace: '登记新的工作区',
      goToParentDirectory: '返回上一级',
      goToParentDirectory2: '返回上一级',
      up: '返回上一级',
      roots: '根目录',
      currentDirectory: '当前目录',
      refreshDirectory: '刷新目录',
      refreshDirectory2: '刷新目录',
      newDirectory: '新建目录',
      selectCurrentDirectory: '选择当前目录',
      pending: '待创建',
      cancelNewDirectory: '取消新建目录',
      cancelNewDirectory2: '取消新建目录',
      outsideAllowedRoots: '不在允许根目录内',
      open: '进入 {value0}',
      open2: '进入 {value0}',
      loadingAllowedRoots: '正在读取允许根目录…',
      expandAndSelectADirectoryToRegister: '展开后选择要登记的目录。',
      onlyTheFirst200ChildDirectoriesAre: '当前目录仅显示前 200 个子目录。',
      selected: '已选择：',
      createAndRegister: '创建并登记',
      registerWorkspace: '登记工作区',
      newDirectory2: '新建目录',
      directoryName: '目录名称',
      enterADirectoryName2: '请输入目录名称',
      cancel: '取消',
      confirm: '确定'
    },
    workspaceRegistrationService: {
      unableToLoadAvailableDirectories: '无法读取可选目录：{value0}',
      aDirectoryWithThisNameAlreadyExists: '同名目录已存在，请修改目录名称。',
      theDirectoryNameIsInvalidEnterA: '目录名称无效，请输入单级目录名称。',
      theSelectedDirectoryIsOutsideTheWorkspace: '所选目录不在节点允许的工作区根目录内。',
      unableToRegisterTheWorkspace: '无法登记工作区：{value0}'
    },
    workspaceSessionService: {
      unableToLoadMoreSessions: '无法加载更多会话：{value0}',
      unableToSynchronizeSessions: '无法同步会话：{value0}'
    },
    workbenchWorkspaceSelectionService: {
      thisWorkspaceIsNoLongerInThe: '该工作区已不在目标节点快照中，不能继续打开。',
      unableToLoadNodeWorkspaces: '无法读取节点工作区：{value0}',
      thisWorkspaceIsNoLongerInThe2: '该工作区已不在目标节点快照中，不能继续打开。',
      unableToRefreshNodeWorkspaces: '无法刷新节点工作区：{value0}',
      thisWorkspaceIsNoLongerInThe3: '该工作区已不在当前节点快照中，不能继续打开。',
      unableToLoadTheNodeState: '无法读取节点内部状态：{value0}'
    },
    workbenchSessionSelectionService: {
      unableToLoadConversationHistory: '无法读取会话记录：{value0}'
    },
    workbenchWorkspaceTreeController: {
      thisWorkspaceIsNoLongerInThe: '该工作区已不在当前节点快照中，不能继续打开。',
      unableToLoadNodeWorkspaces: '无法读取节点工作区：{value0}',
      unregisterThisDoesNotDeleteTheLocal:
        '移除工作区“{value0}”？不会删除本机目录；存在运行中任务时会被拒绝。',
      unregisterWorkspace: '移除工作区',
      unregister: '移除工作区',
      cancel: '取消',
      theWorkspaceWasUnregisteredItsLocalDirectory: '工作区已移除，本机目录未删除。',
      unableToUnregisterTheWorkspace: '无法移除工作区：{value0}'
    },
    workspaceTree: {
      filterNodeWorkspaces: '筛选节点和工作区',
      noMatchingResources: '没有匹配的节点或工作区。',
      ungrouped: '未分组',
      expandWorkspaceGroup: '展开工作区分组 {value0}',
      collapseWorkspaceGroup: '收起工作区分组 {value0}',
      moveWorkspaceToGroup: '移动到分组',
      workspaceGroupName: '工作区分组',
      workspaceGroupMovePlaceholder: '选择已有分组或输入新分组',
      emptyWorkspaceGroupLeavesUngrouped: '留空后保存会移出分组。',
      workspaceGroupNameTooLong: '工作区分组名称不能超过 128 个字符。',
      enterWorkspaceName: '请输入工作区名称。',
      renameWorkspace: '重命名工作区',
      workspaceNameRequired: '工作区名称不能为空。',
      workspaceNameTooLong: '工作区名称不能超过 255 个字符。',
      save: '保存',
      cancel: '取消'
    }
  }
} as const;
