---
title: 安装、配置和使用 OpenCode
lastUpdated: 2026-10-29
---

# 安装、配置和使用 OpenCode

MyAgentRoam 使用 Node 本机的 OpenCode CLI，并只显示 Node 服务账号的全局 `opencode.json` 或 `opencode.jsonc` 中明确配置的服务提供商和模型。它不使用 OpenCode 官方 Gateway，也不会自动读取或转换 Claude Code 配置。

## 安装

必须以 **Node 实际运行的服务账号** 安装，不要只在另一个登录用户下安装。Node 使用的 Node.js 已满足 MyAgentRoam 要求时，可直接执行：

```bash
npm install -g opencode-ai
opencode --version
```

Windows 可使用 npm 安装；安装后应在 Node 服务账号的 PowerShell 中确认 `opencode --version`。其他平台安装方式见 [OpenCode 官方文档](https://opencode.ai/docs/)。远程安装脚本会以当前账号权限执行；下载并检查来源和内容后再决定是否运行，不要直接把未经检查的网络脚本交给 Shell。

## 配置模型

在 Node 服务账号的 OpenCode 全局配置中明确声明服务提供商与模型；仅放在 Workspace 配置中的模型不会出现在模型选择器中。兼容 OpenAI 或 Anthropic 接口的第三方服务也应按 OpenCode 的 Provider 配置处理；MyAgentRoam 不会把 Claude Code 配置自动转换成 OpenCode 配置。

迁移到新的 Node 服务账号时，只复制该账号所需的全局配置与凭据文件（通常位于 `~/.config/opencode/`），并限制为该账号可读；不要复制 `~/.local/share/opencode/` 下的日志、SQLite 数据库、会话或缓存。迁移后在 Node 服务的实际 `HOME`、`PATH` 下执行 `opencode --version`，重启 Node 并在节点详情确认 OpenCode 已可用。

## 步骤

1. 在 Node 服务账号的 OpenCode 全局配置中放置或更新模型，凭据使用服务账号已配置的认证，或使用 MyAgentRoam 环境密钥注入。
2. 在节点详情确认 OpenCode 已出现；打开该 Workspace，新建 OpenCode 会话。
3. 在模型选择器中选择配置里的模型名称；MyAgentRoam 不显示内部的服务提供商前缀。再选择页面实际提供的 `low`、`medium`、`high`、`xhigh` 或 `max` 思考等级。
4. 使用 `/plan` 时，后续消息由 OpenCode 原生 Plan Agent 分析；选择“执行”后回到 build Agent。

**成功标志：** 只出现你显式配置的模型名称，例如 `your-model`；发送后能够回复，并可在刷新后重新打开该会话。

以下是 OpenAI 兼容 **Chat Completions** 接口的自定义 Provider 示意，包含支持图片输入的模型。请替换示例地址和模型，并单独配置环境密钥；模型能力声明须与实际服务一致。字段和适配包适用性以所安装版本的 [OpenCode Provider 文档](https://opencode.ai/docs/providers/)为准；使用 Responses 接口时应按该文档选用 `@ai-sdk/openai`，不要照搬此 Chat Completions 配置。

```jsonc
{
  "provider": {
    "mar": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "https://api.example.com/v1",
        "apiKey": "{env:MAR_PROVIDER_API_KEY}"
      },
      "models": {
        "your-model": {
          "attachment": true,
          "modalities": {
            "input": ["text", "image"],
            "output": ["text"]
          }
        }
      }
    }
  }
}
```

### 支持图片输入的模型

第三方模型即使实际支持识图，OpenCode 也不会只根据模型名称自动判断能力。需要在对应模型配置中明确声明：

```jsonc
{
  "attachment": true,
  "modalities": {
    "input": ["text", "image"],
    "output": ["text"]
  }
}
```

`attachment` 允许 OpenCode 接收消息附件，`modalities.input` 声明模型可接收图片。两项应与模型服务的真实能力一致；不支持图片的模型不要填写。修改全局配置后，应让正在运行的 OpenCode 服务实例退出并重新建立，再开始新的验证消息。

可以先在 Node 服务账号下直接验证 OpenCode 原生附件链路。该命令会发出真实模型请求，只应使用获授权的测试图片和服务：

```bash
opencode run \
  --model mar/your-model \
  --file /path/to/example.png \
  "只回答图片主体是什么，不要调用工具。"
```

成功时，模型应直接描述图片内容。通过 OpenCode `read` 工具读取本地图片成功，只能证明工具读取链路可用，不能证明消息内嵌图片已经启用。

MyAgentRoam 发送图片时会保留 OpenCode 原生附件，并在 Node 私有数据目录的 `temp-files/` 中保留图片文件（已上传的附件直接复用）。OpenCode 在较长会话中裁剪历史媒体、导致模型只收到 `[Media removed]` 时，Agent 会按消息中的降级提示通过 `read` 读取该副本；用户无需重新保存或手工输入路径。

## 失败排查

- 没有模型：检查 Node 服务账号的全局配置是否明确列出模型，以及模型所需的密钥环境变量是否可用；仅在 Workspace 配置的模型不会显示。
- 模型名称不符合预期：检查模型配置中的 `name`；选择器优先显示这个名称，否则显示模型 ID。
- 模型实际支持识图，但消息附件提示不支持图片：检查对应模型是否同时声明 `attachment: true` 和包含 `image` 的 `modalities.input`，然后重建 OpenCode 服务实例。该问题与 PNG、JPG 格式无关。
- `SESSION_INVALID`：刷新会话并重新选择当前可用模型；仍失败时新建 OpenCode 会话。

下一步：[Agent 不可用或模型缺失](runner-troubleshooting.md)。
