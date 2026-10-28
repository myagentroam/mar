---
title: Windows Node and Task Scheduler
lastUpdated: 2026-10-29
---

# Windows Node and Task Scheduler

Use a dedicated Windows account and install the Server-compatible Node package under that account. Store configuration and data in private directories and verify registration from PowerShell before scheduling it.

Run the Node in that user's interactive desktop session so Windows GUI applications started from the Web Terminal or an Agent tool can appear on the current desktop. The user must remain signed in: the Node is offline before sign-in and after sign-out, and Task Scheduler starts it again at the next sign-in. MyAgentRoam does not stream the desktop or application windows to the browser.

Sign in as the target user and run the following commands from that user's PowerShell:

```powershell
$config = 'C:\ProgramData\MyAgentRoam\mar-node.json'
$cli = (Get-Command mar-node.cmd -ErrorAction Stop).Source
$taskName = 'MyAgentRoam Node'
$account = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

<# Keep the launcher beside the configuration so npm upgrades cannot overwrite it. #>
$launcher = Join-Path (Split-Path $config -Parent) 'start-mar-node-hidden.vbs'

<# The outer quotes for cmd.exe preserve spaces in the CLI and configuration paths. #>
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

The task starts the VBS script beside the configuration with `wscript.exe`. `powershell.exe -WindowStyle Hidden` alone cannot hide every window: starting `mar-node.cmd` still creates `cmd.exe`, which Windows Terminal can show in a new tab. `WScript.Shell.Run(..., 0, True)` hides only the Node command-line host; it does not prevent GUI child processes subsequently started by the Node from appearing.

`LogonType=Interactive` places the Node in the target user's desktop session so GUI programs started by an Agent can appear. Do not use S4U, `SYSTEM`, or a Windows service merely to hide windows; those modes prevent GUI processes from appearing on the current desktop.

- `0`: hides the launched `cmd.exe` window.
- `True`: makes the VBS wait for the Node to exit so Task Scheduler tracks its running state correctly.
- `//B`: batch mode; suppresses Windows Script Host error dialogs.
- `//NoLogo`: suppresses the Windows Script Host banner.

When using the Task Scheduler UI, configure the action as follows:

- Program: `C:\Windows\System32\wscript.exe`
- Arguments: `//B //NoLogo "C:\ProgramData\MyAgentRoam\start-mar-node-hidden.vbs"`

Select the target user and **Run only when user is logged on**, with an **At log on** trigger for that user. Disable the execution time limit and configure an already-running task to ignore a duplicate start. Leave **Run with highest privileges** disabled. Do not use Task Scheduler's **Hidden** setting as a way to hide windows: it only affects the task's visibility in Task Scheduler, not `cmd.exe` or Windows Terminal windows. Do not switch the task to `SYSTEM`, LocalService, S4U, another account, or **Run whether user is logged on or not**. Those modes run outside the interactive desktop, so GUI windows cannot appear for the signed-in user.

To migrate an existing task, run the setup through `$action` above, then run:

```powershell
Set-ScheduledTask -TaskName $taskName -Action $action
Stop-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 2
Start-ScheduledTask -TaskName $taskName
```

Changing an elevated task can require UAC; restarting it briefly disconnects Web Terminals and Agents. Verify `LogonType = Interactive`, `RunLevel = Limited`, a `wscript.exe` action with `//B //NoLogo` and `start-mar-node-hidden.vbs`, a Node host `MainWindowHandle` of `0`, and a GUI application launched from the Web Terminal or an Agent tool still appearing on the current desktop. `LastTaskResult = 0x41301` means the task is running, not failed.

Restart the task, then restart Windows and sign in again. Verify automatic reconnection, stable Node identity, Agent discovery, file access, a ConPTY terminal, and a GUI application launched from the Web Terminal or an Agent tool. From management, follow [Upgrade MyAgentRoam](upgrade.md) to push the highest published stable npm version that meets the current business baseline and does not exceed the Server version. Endpoint protection must allow the package installation and native `node-pty` rebuild used by upgrades.

If the Node does not start, inspect the sign-in trigger, interactive logon type, resolved launcher, configuration path, account environment, and Workspace permissions. If a GUI window does not appear, confirm that the currently signed-in desktop belongs to the same account that runs the task.
