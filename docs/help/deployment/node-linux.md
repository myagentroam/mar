---
title: Linux Node 与 systemd
lastUpdated: 2026-11-24
---

# Linux Node 与 systemd

目标是用固定的非 root 服务账号稳定运行 Node。先完成[安装与注册 Node](node-installation.md)中的前台验证。

## 步骤

以下示例以 `ubuntu` 用户为服务账号；替换为你的真实账号和 Workspace 路径：

```bash
mkdir -p "$HOME/.config/myagentroam" "$HOME/.local/share/myagentroam" "$HOME/workspaces"
chmod 700 "$HOME/.config/myagentroam" "$HOME/.local/share/myagentroam"
chmod 600 "$HOME/.config/myagentroam/mar-node.json"
```

先由 `ubuntu` 用户生成 unit 临时文件，再由 root 安装。`mar-node install` 还会准备 Web Fetch 浏览器，可能需要网络下载，见[浏览器准备](node-installation.md#web-fetch-浏览器准备)。`node_bin_dir` 必须在服务账号环境中取得；unit 显式设置 `HOME`、`PATH` 并关闭 systemd 的登录环境覆盖，避免服务进程回落到系统默认 PATH 而无法发现用户级 npm 安装的 Agent CLI：

```bash
unit_file=$(mktemp)
mar-node install \
  --config "$HOME/.config/myagentroam/mar-node.json" \
  --output "$unit_file"
node_bin_dir=$(dirname "$(command -v node)")
sed -i \
  -e 's|^User=mar-node$|User=ubuntu|' \
  -e '/^User=ubuntu$/a SetLoginEnvironment=false' \
  -e '/^ExecStart=/i Environment=HOME=/home/ubuntu' \
  -e "/^ExecStart=/i Environment=PATH=${node_bin_dir}:/home/ubuntu/.local/bin:/usr/local/bin:/usr/bin:/bin" \
  "$unit_file"
sudo install -o root -g root -m 0644 "$unit_file" /etc/systemd/system/myagentroam-node.service
rm -f "$unit_file"
sudo systemctl daemon-reload
sudo systemctl enable --now myagentroam-node.service
sudo systemctl status myagentroam-node.service --no-pager
sudo journalctl -u myagentroam-node.service -f
```

示例 PATH 包含服务账号的 `~/.local/bin`，与安装页的用户级 npm 前缀一致。如果使用其他安装目录，请同时调整 unit 和下方诊断命令，确保验证的是同一环境。

`mar-node install` 只生成以 `mar-node supervise` 为入口的 unit；`systemctl enable --now` 才注册并启动服务。普通 Node、Agent 和终端使用服务账号本身的系统权限，默认 unit 不设置 `ProtectSystem`、`ReadWritePaths`、`NoNewPrivileges` 或 `PrivateTmp`，不额外限制软链接目标、工具缓存和系统临时目录；托管对话仍使用独立沙箱。请使用非 root 账号，并确保其能写入 Node 数据目录、Workspace、Agent 配置及软链接的真实目标；需要额外主机隔离时由管理员按用途显式配置。Supervisor 与 Node 使用同一账号，Supervisor 不会调用 sudo。修改配置或手工升级 npm 包后，重新生成/安装 unit，再执行 `daemon-reload` 和 `restart`。旧服务需要同时检查 `systemctl cat` 显示的本地 drop-in，避免遗留限制继续生效；远程升级不会自动修改 unit。

## 自启动与远程升级验收

不要只检查进程在线；先用当前 Server 版本查询 Registry：

<ServerVersionCommand action="registry" />

再按以下命令核对实际自启动入口和服务账号环境：

```bash
node_bin_dir=$(dirname "$(command -v node)")
sudo systemctl cat myagentroam-node.service
sudo systemctl show myagentroam-node.service -p User -p ExecStart -p Environment
sudo -u ubuntu env HOME=/home/ubuntu PATH="${node_bin_dir}:/home/ubuntu/.local/bin:/usr/local/bin:/usr/bin:/bin" \
  node --version
```

验收结果必须同时满足：

- `ExecStart` 包含 `supervise --config`，不能仍是 `run --config`；
- `User` 是拥有 Node 配置、Agent 登录状态和 Workspace 权限的账号；
- 服务账号能写入 Node `dataDirectory`、Workspace、Agent 配置目录及软链接的真实目标，旧 unit 或 drop-in 未残留非预期的只读挂载限制；
- 服务账号能在 unit 的 `HOME`、`PATH` 下执行 `node`、`npm` 并使用该账号的 npm 配置查询精确版本；
- 服务账号能在同一环境解析并执行所使用的 `mar-node`、`opencode`、`codex`、`claude`；不使用的 Agent 可忽略；
- 需要 npm 类型 MCP 时能解析 `npx`，需要 Git Workspace/技能源时能解析 `git`，需要 Python 工具时能解析 `python3`/`python` 与 `pip3`/`pip`；
- `sudo systemctl restart myagentroam-node.service` 后节点自动重连，节点详情不显示“需手工启用 Supervisor”。

例如，按服务账号环境检查 CLI：

```bash
sudo -u ubuntu env HOME=/home/ubuntu PATH="${node_bin_dir}:/home/ubuntu/.local/bin:/usr/local/bin:/usr/bin:/bin" \
  sh -c 'command -v node npm mar-node; command -v npx git python3 python pip3 pip; opencode --version; codex --version; claude --version'
```

上面的按需命令允许按实际用途缺失；命令返回非零时应逐项运行，不要把未安装的可选 Agent 与工具误判为 Node 故障。如果工具在交互 Shell 可执行、节点详情仍显示“未发现”，先执行 `sudo systemctl restart myagentroam-node.service`，再检查 `systemctl cat` 中是否保留独立的 `Environment=HOME=...`、`Environment=PATH=...` 和 `SetLoginEnvironment=false`。不要只依据 `systemctl show` 的配置值判断，必须以节点详情上报的 Agent 与工具环境为准。

随后可先更新 Server，再按[升级 MyAgentRoam](upgrade.md)从管理页向旧版 Node 推送已发布且符合业务基线、不超过 Server 版本的最高稳定版本。安装目录位于 `dataDirectory/node-versions/<版本>/`；不要把该目录加入 `ReadOnlyPaths`，也不要由其他账号预创建。管理端推送不会执行 sudo，不会修改 systemd unit，也不会自动升级到高于 Server 的版本。

**成功标志：** `systemctl status` 为 running，节点页在线，重启服务后自动重连，详情显示已启用 Supervisor 升级能力。

失败时不要改用 root 来绕过 Agent 问题。检查 unit 中的 `User`、`HOME`、`PATH`、配置权限、工作区权限以及该账号的 Agent 登录状态。
