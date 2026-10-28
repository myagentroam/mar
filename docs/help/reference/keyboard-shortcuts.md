---
title: 键盘快捷键
lastUpdated: 2026-10-26
---

# 键盘快捷键

| 范围                         | Windows/Linux                                     | macOS                                                   | 作用                               | 生效条件                                                                      |
| ---------------------------- | ------------------------------------------------- | ------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------- |
| Composer                     | Enter                                             | Enter                                                   | 发送消息                           | 桌面端输入框已聚焦，且输入法未在组字                                          |
| Composer                     | Shift/Alt+Enter                                   | Shift/Option+Enter                                      | 换行                               | 输入框已聚焦                                                                  |
| Composer                     | Ctrl+Enter                                        | Control+Enter                                           | 以 steer 方式发送消息              | 输入框可发送；空闲时按普通发送                                                |
| Composer                     | Esc                                               | Esc                                                     | 关闭补全菜单                       | `@`、`#` 或 `/` 菜单已打开；保留输入，不停止任务                              |
| Composer                     | Esc                                               | Esc                                                     | 停止当前任务                       | 输入框已聚焦，未打开补全菜单，任务可中断且未在发送中                          |
| Composer                     | @                                                 | @                                                       | 打开工作区文件或文件夹引用列表     | 输入框已聚焦                                                                  |
| Composer                     | /                                                 | /                                                       | 打开当前 Agent 可用命令            | 在消息起始位置输入 `/`                                                        |
| 工作区 Tab                   | Alt+←/→ / Ctrl+Tab / Ctrl+Shift+Tab               | Option+←/→ / Control+Tab / Control+Shift+Tab            | 循环切换到前一个或后一个工作区标签 | 工作模式下有活动标签；Composer 内也生效；其他输入框、编辑器、终端或弹窗除外   |
| 工作区 Tab                   | Ctrl+1…9 / Ctrl+0                                 | Control+1…9 / Control+0                                 | 切换到第 1…9 / 10 个工作区标签     | 对应序号标签已打开；Composer 内也生效；其他输入框、编辑器、终端或弹窗除外     |
| 新建会话                     | Ctrl+N / Alt+N                                    | Control+N / Option+N                                    | 打开当前工作区的新建会话草稿       | 当前 Node 与工作区可用；Composer 内也生效；其他输入框、编辑器、终端或弹窗除外 |
| 工作区 Tab                   | Ctrl+W / Alt+W                                    | Ctrl+W / Option+W                                       | 关闭当前非固定工作区标签           | 工作模式；固定标签保留；Composer 内也生效；其他输入框、编辑器、终端或弹窗除外 |
| 工作区 Tab                   | Ctrl+Shift+W / Alt+Shift+W                        | Ctrl+Shift+W / Option+Shift+W                           | 关闭全部非固定工作区标签           | 工作模式；固定标签保留；Composer 内也生效；其他输入框、编辑器、终端或弹窗除外 |
| 全局                         | Ctrl+Shift+E                                      | Cmd+Shift+E                                             | 打开或关闭最近会话                 | 页面已打开                                                                    |
| 工作区                       | Ctrl+Shift+O                                      | Cmd+Shift+O                                             | 快速打开工作区、会话、符号或文件   | 工作模式下存在可用 Node                                                       |
| 快速打开                     | ↑/↓、Enter/Esc                                    | ↑/↓、Enter/Esc                                          | 选择、打开结果或关闭浮层           | 快速打开浮层已打开                                                            |
| 快速打开                     | Ctrl+Enter                                        | Cmd+Enter                                               | 在独立预览窗口打开选中符号或文件   | 快速打开浮层已打开且选中的是符号或文件                                        |
| 工作区                       | Ctrl+Shift+K                                      | Cmd+Shift+K                                             | 在检查器打开 Git 变更              | 当前工作区为 Git 工作区                                                       |
| 工作区                       | Ctrl+Shift+F                                      | Cmd+Shift+F                                             | 搜索工作区文件内容                 | 当前 Node 支持内容搜索                                                        |
| 文件树/预览                  | Ctrl+点击                                         | Cmd+点击                                                | 在复用的独立预览窗口打开文件       | 文件项或聊天内的文件链接可用                                                  |
| 文件标签                     | ←/→、Home/End                                     | ←/→、Home/End                                           | 在标签间移动或跳到首尾             | 文件标签获得焦点                                                              |
| 文本文件预览或 Diff          | Ctrl+F                                            | Cmd+F                                                   | 查找当前内容                       | 已打开文本文件或 Diff                                                         |
| 文件预览                     | Alt+Left/Right                                    | Option+Left/Right                                       | 返回/前进访问位置                  | 文件预览获得焦点且存在对应历史                                                |
| 文本编辑器                   | Ctrl+A                                            | Cmd+A                                                   | 全选当前编辑器内容                 | CodeMirror 或大文件轻量文本编辑器已获得焦点                                   |
| 文本文件或 Diff              | Ctrl+E                                            | Cmd+E                                                   | 切换编辑/只读，或打开对应文本 Tab  | 当前页明确支持该操作                                                          |
| 文本文件编辑                 | Ctrl+H                                            | Cmd+H                                                   | 打开查找与替换                     | 文件可写且当前处于编辑模式                                                    |
| 文本文件编辑                 | Ctrl+S                                            | Cmd+S                                                   | 保存当前文件                       | 文件可写且当前处于编辑模式                                                    |
| 文本文件预览                 | Alt+M                                             | Option+M                                                | 打开当前文件的符号表               | 当前文件类型支持符号解析                                                      |
| Markdown 文件预览            | Ctrl+Shift+V                                      | Cmd+Shift+V                                             | 在独立窗口打开渲染预览             | 已在文件预览中打开 Markdown 文件                                              |
| Composer 模型菜单            | Alt+M                                             | Option+M                                                | 打开模型菜单                       | 输入框已聚焦                                                                  |
| Composer 模型菜单            | Tab/Shift+Tab                                     | Tab/Shift+Tab                                           | 切换模型与推理强度分组             | 菜单已打开且包含两个分组                                                      |
| 队列编辑                     | Enter / Ctrl+Enter                                | Enter / Control+Enter                                   | 保存修改 / 执行修改后的消息        | 正在编辑排队消息                                                              |
| 文件标签                     | Ctrl+W / Alt+W                                    | Ctrl+W / Option+W                                       | 关闭当前文件标签                   | 文件窗口已打开；最后一个标签关闭后结束窗口；未保存编辑先确认                  |
| 文件窗口                     | Esc / Ctrl+Shift+W / Alt+Shift+W                  | Esc / Ctrl+Shift+W / Option+Shift+W                     | 关闭全部文件标签及文件窗口         | 编辑器焦点内同样可用；Esc 先关闭最上层查找、菜单或设置弹窗                    |
| 文本文件预览或 Diff 内嵌查找 | Enter / Shift+Enter                               | Enter / Shift+Enter                                     | 跳到下一个 / 上一个匹配项          | 内嵌查找已打开                                                                |
| 文本文件预览或 Diff 内嵌查找 | Esc                                               | Esc                                                     | 关闭内嵌查找                       | 内嵌查找已打开                                                                |
| 无 Tab 的独立渲染预览        | Esc / Ctrl+W / Alt+W / Ctrl+Shift+W / Alt+Shift+W | Esc / Ctrl+W / Option+W / Ctrl+Shift+W / Option+Shift+W | 请求关闭该预览窗口                 | 浏览器可能阻止关闭由用户手动打开的标签                                        |
| 工作区终端                   | Ctrl+Shift+`                                      | Cmd+Shift+`                                             | 展开或收起当前工作区终端           | 已选中工作区                                                                  |
| 工作区终端                   | 右键                                              | 右键                                                    | 打开复制、粘贴和清屏菜单           | 桌面端终端已打开                                                              |

终端已获得焦点时仍可使用 `Ctrl/Cmd+Shift+\`` 收起；再次按下会重新展开并聚焦输入。收起不会关闭终端。`Ctrl/Cmd+F`、`Ctrl/Cmd+A` 只在当前焦点或活动页面明确提供内部查找或全选能力时拦截；普通页面、表单和原生输入控件保留浏览器或控件默认行为。`Shift+Tab` 始终保留原有焦点与菜单操作。浏览器、操作系统或远程桌面可能拦截部分快捷键；以界面底部提示为准。移动端使用触摸菜单，不要求物理快捷键。输入法正在组字或操作加载时，快捷键可能暂不可用。

移动端查看文本文件或 Diff 时，可点击预览操作区的查找图标打开同一内嵌查找。

移动端浏览器返回会关闭整个文件窗口，不逐个关闭文件标签，也不进入文件访问位置历史；未保存确认取消后保持当前窗口。独立文件页及独立渲染预览沿用相同返回行为。

`Ctrl+N`、`Ctrl+W` 和 `Ctrl+Shift+W` 在浏览器/PWA 将按键交给页面时生效；若浏览器直接新建窗口或关闭标签/窗口，请使用对应的 `Alt`（macOS 为 `Option`）组合。

`Ctrl+Tab` 与 `Ctrl+Shift+Tab` 分别与 `Alt+→`、`Alt+←` 等价，按标签显示顺序首尾循环；macOS 同样使用 Control。只有一个工作区标签或按键重复时仍消耗循环切换快捷键，但不重新激活标签。工作区切换、新建会话和关闭快捷键在 Composer 内也生效；其他输入框、编辑器、终端和弹窗保留原生行为。Ctrl+Tab 系列同样需要浏览器/PWA 将事件交给页面。

按序号选择 Workspace Tab 在所有平台均使用 Control，不再提供 Alt/Option 加数字的等价组合。目标存在时消耗长按的重复按键，但不会重复激活标签。浏览器若自行处理 `Ctrl+1…9/0`，请点击工作区标签，或使用 `Alt+←/→`（macOS 为 `Option+←/→`）切换。

工作模式输入预测启用后，在前台 Composer 中按 `Tab Tab` 手动请求，生成中单按 `Tab` 取消；候选显示时 `Tab` 采用、`Esc` 取消且不停止 Agent。输入框始终拦截普通 `Tab` 并保持焦点，即使预测不可用，`Shift+Tab` 保持原行为。详见 [输入预测](../workbench/composer.md#输入预测-prompt-tab)。
