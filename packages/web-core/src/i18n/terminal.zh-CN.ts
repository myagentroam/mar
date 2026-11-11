export const terminalZhCN = {
  generated: {
    terminalTabView: {
      terminalCopyFailedCheckBrowserClipboardPermissions: '终端复制失败，请检查浏览器剪贴板权限。',
      terminalPasteFailedCheckClipboardPermissions:
        '终端粘贴失败，请检查剪贴板权限或使用 Ctrl+Shift+V。',
      copy: '复制',
      paste: '粘贴',
      clear: '清屏',
      terminalOutput: '终端输出'
    },
    terminalDock: {
      nodeTerminal: '节点终端',
      workspaceTerminal: '终端',
      newTerminal: '新建终端',
      selectAnOnlineNodeFirst: '请先选择一个在线节点。',
      theTargetNodeDoesNotProvideA: '目标节点未提供终端。',
      unableToLoadTerminals: '无法读取终端：{value0}',
      unableToCreateATerminal: '无法创建终端：{value0}',
      unableToCloseTheTerminal: '无法关闭终端：{value0}',
      unableToReleaseTerminals: '无法释放 {value0} 个终端：{value1}',
      createResultUnknown: '终端创建结果未知，终端可能已经创建。{value0}',
      closeResultUnknown: '终端关闭结果未知，终端可能已经关闭。{value0}',
      releaseResultsUnknown:
        '{value0} 个终端的释放结果未能全部确认，部分终端可能仍在运行。{value1}',
      terminalProfile: '终端配置',
      terminalProfile2: '终端配置',
      collapseTerminal: '收起终端',
      expandTerminal: '展开终端',
      collapseTerminal2: '收起终端',
      expandTerminal2: '展开终端',
      collapseTerminal3: '收起终端',
      expandTerminal3: '展开终端',
      list: '{value0}列表',
      closeTerminal: '关闭终端 {value0}',
      newTerminal2: '新建终端'
    },
    terminalRelayService: {
      terminalOccupiedRetrying: '终端仍被占用，正在等待旧连接释放并重连。',
      terminalConnectionLostReconnectingInSeconds: '终端连接中断，{value0} 秒后自动重连',
      reconnectingTerminal: '正在重新连接终端…',
      theTerminalWasTakenOverInAnother: '终端已在其他页面接管。',
      theTerminalRelayReturnedInvalidDataReconnecting: '终端中继返回了无效数据，正在自动重连。'
    }
  }
} as const;
