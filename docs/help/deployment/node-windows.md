---
title: Windows Node 与任务计划
lastUpdated: 2026-10-11
---

# Windows Node 与任务计划

目标是让 Windows Node 在用户登录后，以拥有 Agent 登录状态和工作区权限的同一账号运行。Node 位于该用户的交互式桌面会话，因此从 Web Terminal 或 Agent 工具启动的 Windows GUI 程序可以显示在当前桌面。先完成[安装与注册 Node](node-installation.md)中的前台验证。

该部署方式要求目标用户保持登录。用户未登录或注销后，Windows 不存在可显示 GUI 的交互桌面，Node 会保持离线；重新登录后计划任务会自动启动 Node。MyAgentRoam 不提供远程桌面或窗口画面转发。

## 步骤

先使用需要显示 GUI、拥有 Agent 登录配置和 Workspace 权限的普通用户登录 Windows，再在该用户的 PowerShell 中执行以下命令：

```powershell
$config = 'C:\ProgramData\MyAgentRoam\mar-node.json'
$cli = (Get-Command mar-node.cmd -ErrorAction Stop).Source
$taskName = 'MyAgentRoam Node'
$account = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

<# 启动脚本放在配置文件旁，避免升级 npm 包时被覆盖。 #>
$launcher = Join-Path (Split-Path $config -Parent) 'start-mar-node-hidden.vbs'

<# cmd.exe 的首尾双引号用于正确处理 CLI 和配置路径中的空格。 #>
$command = ('cmd.exe /d /c ""{0}" supervise --config "{1}""' -f $cli, $config)
$vbsCommand = $command.Replace('"', '""')

$vbs = @"
Option Explicit

Dim shell, exitCode
Set shell = CreateObject("WScript.Shell")
exitCode = shell.Run("$vbsCommand", 0, True)
WScript.Quit exitCode
"@

Set-Content -LiteralPath $launcher -Value $vbs -Encoding ASCII

$action = New-ScheduledTaskAction `
    -Execute "$env:SystemRoot\System32\wscript.exe" `
    -Argument ('//B //NoLogo "{0}"' -f $launcher)

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $account

$principal = New-ScheduledTaskPrincipal `
    -UserId $account `
    -LogonType Interactive `
    -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Force

Start-ScheduledTask -TaskName $taskName
Get-ScheduledTask -TaskName $taskName | Get-ScheduledTaskInfo
```

任务以 `wscript.exe` 启动配置旁的 VBS 脚本。仅使用 `powershell.exe -WindowStyle Hidden` 不足以隐藏窗口：调用 `mar-node.cmd` 时仍会创建 `cmd.exe`，Windows Terminal 可能将其显示为新标签页。VBS 的 `WScript.Shell.Run(..., 0, True)` 会隐藏 Node 自身的命令行宿主，但不会阻止 Node 后续启动的 GUI 子进程显示。

`LogonType=Interactive` 让 Node 位于目标用户的桌面会话，使 Agent 启动的 GUI 程序能够显示。不要为隐藏窗口而使用 S4U、`SYSTEM` 或 Windows 服务；这些方式会让 GUI 进程无法显示到当前桌面。

- `0`：隐藏被启动的 `cmd.exe` 窗口。
- `True`：VBS 等待 Node 退出，使计划任务能够正确跟踪运行状态。
- `//B`：批处理模式，不显示 Windows Script Host 错误弹窗。
- `//NoLogo`：不显示 Windows Script Host 标识。

如果使用 Windows“任务计划程序”图形界面创建，操作填写：

- 程序：`C:\Windows\System32\wscript.exe`
- 参数：`//B //NoLogo "C:\ProgramData\MyAgentRoam\start-mar-node-hidden.vbs"`

选择目标用户和“仅当用户登录时运行”，触发器选择目标用户“登录时”；同时取消执行时限，并将重复启动设置为不创建新实例。不要选择“使用最高权限运行”，也不要勾选任务计划程序中的“隐藏”作为窗口隐藏手段：该选项只影响任务在任务计划程序中的展示，不会隐藏 `cmd.exe` 或 Windows Terminal 窗口。不能改用 `SYSTEM`、LocalService、S4U 或其他账号，也不要通过 `Highest` 绕过路径或权限问题。

“无论用户是否登录都要运行”和 Windows 服务都处于非交互会话，即使进程成功启动，GUI 也不会显示到用户桌面，因此不适用于需要显示 GUI 的 Node。

任务账号必须能写入 Node 数据目录，Supervisor 不会触发 UAC 或远程提权。首次启用 Supervisor 时，确认 `Get-Command mar-node.cmd` 指向支持版本，再用同一命令更新任务。停止或删除：

```powershell
Stop-ScheduledTask -TaskName 'MyAgentRoam Node'
Unregister-ScheduledTask -TaskName 'MyAgentRoam Node' -Confirm:$false
```

旧任务迁移时，先运行上面的变量和 `$action` 创建部分，再执行：

```powershell
Set-ScheduledTask -TaskName $taskName -Action $action
Stop-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 2
Start-ScheduledTask -TaskName $taskName
```

更新现有高权限任务可能触发 UAC；重启期间 Web Terminal 和 Agent 会短暂断开。

## 自启动与远程升级验收

以管理员 PowerShell 核对任务实际动作，不要只查看任务名称：

```powershell
$task = Get-ScheduledTask -TaskName 'MyAgentRoam Node'
$task.Principal | Format-List UserId, LogonType, RunLevel
$task.Triggers
$task.Actions | Format-List Execute, Arguments
Get-ScheduledTaskInfo -TaskName 'MyAgentRoam Node'
```

验收结果必须同时满足：

- 触发器为目标用户登录，Principal 的 `LogonType` 为 `Interactive`，执行时限为无限且不允许重复实例，最近运行结果为成功，失败后允许重启；
- Actions 的参数包含 `supervise --config`，不能仍是 `run --config`；
- `LogonType` 为 `Interactive`、`RunLevel` 为 `Limited`；Actions 使用 `wscript.exe`，参数包含 `//B //NoLogo` 和 `start-mar-node-hidden.vbs`；
- Node 宿主的 `MainWindowHandle` 为 `0`，并从 Web Terminal 启动一个实际 GUI 程序确认它仍显示在当前桌面；`LastTaskResult = 0x41301` 表示任务正在运行，不是失败；
- 运行账号能读写配置、`dataDirectory`、Workspace，并能读取自己的 Agent 登录和 npm 配置；
- 在该账号的登录环境中，`node.exe`、`npm.cmd`、`mar-node.cmd` 都可解析，且 Registry 可访问；
- 需要 npm 类型 MCP 时能解析 `npx.cmd`，需要 Git Workspace/技能源时能解析 `git.exe`，需要 Python 工具时能解析 `python.exe` 与 `pip.exe`；
- 执行 `Stop-ScheduledTask`、`Start-ScheduledTask` 后 Node 自动上线，节点详情不显示“需手工启用 Supervisor”。

Supervisor 会把远程升级版本安装到 `dataDirectory\node-versions\<版本>\`，并在同一任务进程中切换 Node 子进程。该目录必须允许任务账号创建文件和执行 Node；安全软件不得隔离 npm 安装或 `node-pty` rebuild。管理端推送不会触发 UAC、创建计划任务或修改任务账号，因此首次自启动配置必须由本机管理员完成。

可在同一任务账号下先做 Registry 检查：

<ServerVersionCommand action="registry" platform="powershell" />

并在该账号的 PowerShell 中检查实际命令解析结果：

```powershell
Get-Command node, npm, mar-node -ErrorAction Stop
Get-Command npx, git, python3, python, pip3, pip -ErrorAction SilentlyContinue
Get-Command opencode, codex, claude -ErrorAction SilentlyContinue
```

后两行都是按需检查，未安装未使用的 Agent 或工具不影响 Node 上线。计划任务启动后，以节点详情中的“支持 Agent”和“工具环境”为最终结果；若与当前 PowerShell 不一致，应检查计划任务的运行账号、用户配置目录和 `PATH`，不要为绕过问题改用 `SYSTEM`。

然后按[升级 MyAgentRoam](upgrade.md)从管理页推送 npm 中不超过当前 Server 版本的最高稳定版本。升级后再次查看任务与节点详情，确认计划任务仍在运行、Node 版本已更新且既有 Workspace 可打开。

**成功标志：** 重新启动任务，或重启 Windows 并登录目标用户后，Node 自动上线，支持 Agent 保持可发现，详情显示已启用 Supervisor 升级能力；从 Web Terminal 或 Agent 工具启动的 GUI 程序显示在该用户当前桌面。

失败时检查任务“触发器=登录时”“仅当用户登录时运行”、实际启动器、配置路径、实际运行账号、`PATH`、用户配置目录以及工作区权限。GUI 未显示时还应确认当前桌面登录用户就是任务运行账号。不要改用 `SYSTEM` 来绕过普通用户的登录配置问题。
