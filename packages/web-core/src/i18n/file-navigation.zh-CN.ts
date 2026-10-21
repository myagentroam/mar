export const fileNavigationZhCN = {
  workspaceDisplayFilter: { empty: '没有匹配的文件或目录。' },
  settings: {
    iconThemeSeti: 'Seti',
    iconThemeMaterial: 'Material'
  },
  generated: {
    workspaceFileTree: {
      fileTree: '文件树',
      moreActionsFor: '{value0} 更多操作',
      open: '打开',
      openInNewWindow: '在独立窗口打开',
      download: '下载',
      newFile: '新建文件',
      newFolder: '新建文件夹',
      uploadFiles: '上传文件',
      copyRelativePath: '复制相对路径',
      rename: '重命名',
      delete: '删除',
      loading: '加载中…',
      loadMore: '加载更多'
    },
    quickOpenDialog: {
      quickOpen: '快速打开',
      resultTypes: '结果类型',
      all: '全部',
      workspace: '工作区',
      session: '会话',
      symbol: '符号',
      file: '文件',
      definition: '定义',
      reference: '引用',
      enterANameOrPath: '输入名称、路径或完整符号名…',
      searching: '正在查找…',
      preparing: '正在准备索引…',
      failed: '查询失败，其他可用结果仍可使用。',
      unavailable: '当前工作区或 Node 不支持此查询。',
      timedOut: '等待超时，后台准备可能仍在进行，请重试。',
      incomplete: '结果不完整，请缩小查询范围。',
      completeSymbolRequired: '请输入完整符号名，不支持限定名称或部分表达式。',
      details: '错误详情',
      retry: '重试',
      noMatches: '未找到匹配结果'
    },
    composerFileReferencePicker: {
      referenceAFileOrFolder: '引用文件或文件夹',
      searchingFilesAndFolders: '正在查找文件或文件夹…',
      folder: '文件夹',
      file: '文件',
      noMatchingPaths: '未找到匹配路径'
    }
  }
} as const;
