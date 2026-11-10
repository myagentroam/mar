---
title: 部署 MyAgentRoam Server 与 Web
lastUpdated: 2026-11-10
---

# 部署 MyAgentRoam Server 与 Web

本页以公开产品根目录的唯一 `compose.yaml` 部署 MySQL、SearXNG 和自带 Web 的 Server；生产入口由你的反向代理提供 HTTPS。

## 正式部署

正式部署使用同一套产品源码和构建，入口为 `mar-server/`、`mar-web-console/` 和根 `compose.yaml`。未激活时显示社区版，提供工作区会话、文件、Git、终端、模型与凭据管理、Skill/MCP，以及个人模板和托管对话；有效企业 License 在同一安装中启用组织、用户、共享授权、SSO 和审计，无需更换镜像。另一种安装入口见 [npm 快速开始](npm-quick-start.md)。

两种授权状态都使用 `/console` 工作台和 `/docs/` 文档中心。原有指向 `/` 的链接继续可用，浏览器在产品内进入 `/console`，保留查询参数与片段。部署后应验证实际登录和一次工作区操作，不能仅凭 `/health` 成功判断完整工作台已可用。

## 前置条件

完成[部署前准备](prerequisites.md)，并取得当前发布版本的项目目录或镜像构建上下文。

## 步骤

1. 在仅管理员可读的源码部署目录复制根模板并保护配置文件：

   ```bash
   cp .env.example .env
   chmod 600 .env
   ```

   继续前填写所有空值：`MAR_PUBLIC_ORIGIN` 为外部 HTTPS 地址；MySQL Root 与应用密码应分别生成高强度值，`MAR_SEARXNG_SECRET` 使用随机长字符串；`MAR_SERVER_SSH_DIR` 指向已存在目录的绝对路径。Compose 会把 `MAR_MYSQL_PASSWORD` 嵌入数据库 URL，因此应用密码应使用 URL 安全字符。模板故意不提供可用秘密值，缺少必填值时 Compose 会拒绝启动。

   `MAR_SERVER_SSH_DIR` 填写当前独立部署账号的 `.ssh` 绝对路径。Compose 会把整个目录只读挂载到 Server；即使暂不使用 SSH 技能源，也应创建权限正确的空目录。

2. 检查该目录及私钥只允许部署账号访问。如果使用 SSH Skill 源，在部署主机以部署账号验证对目标仓库的非交互读取；将下例中的地址替换为你有权访问的仓库：

   ```bash
   GIT_SSH_COMMAND='ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null' \
     git ls-remote git@<repository-host>:<owner>/<repository>.git HEAD
   ```

   上例会连接外部仓库，且与 Server 的 SSH Skill 源一样跳过主机指纹校验，存在冒充服务器的风险；仅对可信网络和仓库使用，不要把该选项设为全局 SSH 默认值。`.ssh/config` 中的 `IdentityFile` 应写成 `~/.ssh/密钥名`，不要引用容器内不存在的宿主机绝对路径。宿主机部署账号 UID 应与镜像内 `node` 用户 UID 一致（默认 `1000`），否则 OpenSSH 可能因所有权不匹配拒绝私钥。

3. 启动服务：

   ```bash
   docker compose up -d --build
   docker compose ps
   ```

4. 将反向代理的 HTTPS 流量转发到统一 Server 的宿主机 `5190` 端口；同时允许 Upgrade/WebSocket 请求，不要把 `/api/` 或 WebSocket 升级请求缓存。
5. 在 Server 主机检查健康状态：

   ```bash
   curl -fsS http://127.0.0.1:5190/health
   ```

6. 用浏览器打开 `MAR_PUBLIC_ORIGIN`。

**成功标志：** `docker compose ps` 中 MySQL、SearXNG、Server 三个服务健康，打开 HTTPS 站点后可进入 `/console` 登录。

## 失败排查

- MySQL 未健康：执行 `docker compose logs mysql`，确认密码变量已填写且 `13006` 未被占用。
- SSH 技能源不可读：确认 `MAR_SERVER_SSH_DIR` 是绝对路径、部署账号 UID 为 `1000`，并检查 `.ssh/config` 的 `IdentityFile` 在容器内仍指向 `~/.ssh/`。
- 登录页打开但请求失败：检查反向代理是否把 `/api/` 转到同一站点，以及 `MAR_PUBLIC_ORIGIN` 是否完全匹配外部地址。
- Node 无法连接：Node 控制连接无需开放入站 HTTP API；检查 Node 到 `MAR_PUBLIC_ORIGIN` 的出站 HTTPS/WSS 与证书链。

安全提示：`.env` 含数据库密码，不要提交 Git、贴入对话或放在 Web 根目录。

下一步：[首次登录与修改初始密码](first-login.md)；生产网络细节见[网络、TLS 与 WebSocket](../deployment/network.md)。

正式部署的社区与企业状态都要求有效的真实主机 UUID。容器必须将宿主 `/sys/class/dmi/id/product_uuid` 只读挂载到 `/license-host/product_uuid`，源文件必须存在；原生正式部署可用 `MAR_LICENSE_HOST_PATH` 指定真实 UUID 文件。[npm 快速开始](npm-quick-start.md)无需 UUID，也不支持激活。

## 连接独立 Node

正式部署中，Server 只托管 Web 与 API，不包含 Node 执行器。使用工作区、Agent、文件、终端或托管对话前，请独立[安装并注册 Node](../deployment/node-installation.md)。托管与浏览器执行依赖配置在 Node 主机上，不在 Server 镜像中。
