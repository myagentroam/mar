---
title: 文件、Git 与终端
lastUpdated: 2026-08-22
---

# 文件、Git 与终端

文件树、Git 和终端都在 Node 的 Workspace 内执行，不会先上传完整工作区到 Server。

- `@` **引用**告诉 Agent 使用工作区里的文件或文件夹，不等同于上传附件。
- **附件**上传当前消息需要的独立内容；它与工作区路径是两套语义。
- **文件预览**用于读文件；Git Changes、聊天中的文件更改默认打开 Diff，避免把改动误看成普通版本。
- **终端**由 Node 服务账号启动；收起终端面板或切换工作区不会关闭它，显式关闭终端标签或重启 Node 才会终止对应进程。

文件操作受 `allowedRoots`、Workspace 和当前授权共同限制；终端不是任意提权入口。详细操作见[文件](../workbench/files.md)、[Git Changes](../workbench/git-changes.md)和[终端](../workbench/terminal.md)。

## 选择正确入口

当你希望 Agent 自己读取当前代码时使用 `@` 引用；当你需要把工作区外的内容作为这条消息输入时使用附件；当你要确认 Agent/你自己已改动什么时看 Diff；当你要执行受控本机命令时打开终端。四者可组合，但都不会突破当前 Workspace 的授权边界。

对文件进行重命名、移动或删除前先检查 Git 状态。MyAgentRoam 不把这些操作变成版本控制，也不会在删除后保留隐藏回收站。
