export const filePreviewZhCN = {
  common: {
    save: '保存',
    cancel: '取消',
    gitDiff: 'Git 差异'
  },
  generated: {
    imagePreview: {
      loadFailed: '图片加载失败。',
      viewOriginal: '查看原图',
      retry: '重试'
    },
    gitDiffViewer: {
      gitDiffHasNoDisplayableTextContent: 'Git Diff 没有可显示的文本内容。',
      gitDiffLoadFailed: 'Git Diff 加载失败。',
      retry: '重试',
      diffToolbar: 'Diff 工具栏',
      previousFile: '上一个文件',
      previousFile2: '上一个文件',
      filesAvailable: '共 {value0} 个可查看文件',
      nextFile: '下一个文件',
      nextFile2: '下一个文件',
      previousChange: '上一个差异',
      previousChange2: '上一个差异（↑）',
      changes: '共 {value0} 处差异',
      nextChange: '下一个差异',
      nextChange2: '下一个差异（↓）',
      closeDiffPreview: '关闭 Diff 预览',
      diffPreviewActions: 'Diff 预览操作',
      downloadDiff: '下载 Diff',
      closeDiffPreview2: '关闭 Diff 预览',
      binaryFilesDoNotSupportDiff: '非文本文件不支持代码比较。',
      openFilePreview: '打开文件预览',
      filePreviewRequiresNewerNode: '请先升级节点后再预览此文件。',
      before: '修改前',
      after: '修改后',
      before2: '修改前',
      after2: '修改后',
      before3: '修改前',
      after3: '修改后',
      theFileExceeds4MiBAndWas: '文件超过 4 MiB，未加载预览。',
      thisVersionDoesNotExist: '该版本不存在。',
      thisBinaryFileTypeCannotBePreviewed: '此二进制文件类型暂不支持浏览器预览。',
      theCurrentNodeVersionDoesNotSupport: '当前节点版本不支持二进制 Diff 预览。',
      theCurrentNodeDidNotReturnThe: '当前节点未返回新文件全文；以下仅显示受限统一 Diff。',
      workingTree: '工作树',
      showingTheFirst512KiB: '仅显示前 512 KiB',
      fullWorkingTreeFile: '工作树文件全文',
      emptyFile: '（空文件）',
      diffCodeMinimap: 'Diff 代码缩略图'
    },
    standaloneFilePreviewPage: {
      theFilePreviewURLIsInvalid: '文件预览地址无效。',
      unableToReadTheFileCheckYour: '无法读取文件，请确认登录状态、节点连接和文件权限。'
    },
    filePreviewDialog: {
      filePreview: '{value0} 文件预览',
      readOnlyFile: '只读文件',
      downloadFile: '下载文件',
      closePreview: '关闭预览',
      filePreviewActions: '文件预览操作',
      downloadFile2: '下载文件',
      closePreview2: '关闭预览',
      codeEditorPreview: '代码编辑器预览',
      onlyTheFirst512KiBIsShown:
        '当前仅显示文件的前 512 KiB；下载会读取节点允许范围内的完整文本文件。',
      filePreview2: '{value0} 文件预览',
      thisFileTypeCannotBePreviewedIn:
        '此文件类型暂不支持浏览器预览；你仍可使用右上角按钮下载文件。',
      previewFailedDownloadInstead: '文件预览失败；你仍可使用右上角按钮下载文件。',
      loadingPreview: '正在加载中…',
      filePreviewTabs: '文件预览标签'
    }
  },
  fileEditor: {
    openSource: '打开源文件',
    openSourceShortcut: '打开源文件（Ctrl/⌘+E）',
    edit: '编辑文件',
    editing: '正在编辑',
    readOnly: '只读文件',
    encodingFallback: '{encoding} 回退解码，文字可能不准确',
    saved: '文件已保存。',
    saveFailed: '文件保存失败。',
    conflict: '文件已被其他操作修改，请重新加载后再编辑。',
    unsavedTitle: '存在未保存的修改',
    unsavedMessage: '退出将丢失未保存的修改，是否继续？',
    symbols: '符号表',
    searchSymbols: '搜索符号',
    noSymbols: '暂无符号',
    definitions: '定义位置',
    references: '引用',
    files: '文件',
    navigationResults: '跳转位置',
    preparingNavigation: '正在准备代码导航…',
    navigationLimited: '符号索引已达到容量上限，导航结果可能不完整。',
    navigationUnavailable: '当前 Node 的符号索引暂不可用。',
    noDefinition: '未找到定义或引用。'
  },
  filePreviewContext: {
    copy: '复制',
    paste: '粘贴',
    reload: '重新加载',
    clipboardFailed: '无法访问剪贴板。',
    reloadUnsaved: '重新加载会丢弃未保存的修改，是否继续？'
  },
  markdownPreview: {
    open: '打开 Markdown 预览',
    refresh: '刷新预览',
    settings: 'Markdown 预览设置',
    watermarkEnabled: '显示水印',
    watermarkText: '水印文本',
    watermarkPlaceholder: '请输入水印文本',
    watermarkRequired: '启用水印时请输入水印文本。'
  },
  htmlPreview: {
    open: '运行 HTML 预览',
    trustedWarning:
      '受信任代码：此 HTML 与控制台共用主机名，可能使用当前登录权限并将文件发送到外部站点。',
    isolatedWarning: '此 HTML 可以运行 JavaScript、读取所在目录及下级文件，并向外部站点发送内容。',
    unavailable: '无法启动 HTML 预览，请检查文件访问权限与预览域名配置。'
  },
  inlineFind: {
    label: '文件内查找',
    placeholder: '查找',
    shortcutDescription: '在文本文件预览或 Diff 中查找',
    previous: '上一个匹配项',
    next: '下一个匹配项',
    close: '关闭查找',
    replacePlaceholder: '替换为',
    selectAll: '选择全部匹配项',
    matchCase: '区分大小写',
    regexp: '正则表达式',
    wholeWord: '全字匹配',
    replace: '替换',
    replaceAll: '全部替换'
  },
  gitDiffViewer: {
    mobileSummary: 'Diff 摘要',
    mobileFileSummary: '文件 {value0} / {value1}',
    mobileChangeSummary: '差异 {value0} / {value1}',
    collapseMobileActions: '收起 Diff 快捷操作',
    expandMobileActions: '展开 Diff 快捷操作'
  },
  filePreviewDialog: {
    closeFileWindow: '关闭文件窗口',
    collapseMobileActions: '收起文件预览快捷操作',
    expandMobileActions: '展开文件预览快捷操作'
  }
} as const;
