---
title: 维护对话模板 Workspace
lastUpdated: 2026-10-29
---

# 维护对话模板 Workspace

对话模板的来源 Workspace 同时承担两种职责：供维护人员持续编辑、测试和说明模板，以及生成普通用户实际使用的只读发布版本。为了避免维护说明被带入用户对话，根目录使用独立的维护文件和模板指令文件。

## 推荐目录结构

```text
template-workspace/
├── README.md
├── AGENTS.md
├── AGENTS.template.md
├── .agents/
│   └── skills/
├── knowledge/
├── scripts/
└── ...
```

三个根文件的职责不同：

- `README.md`：面向维护人员，说明模板目标、依赖、测试方法、发布步骤和版本记录。发布时排除。
- `AGENTS.md`：约束在来源 Workspace 中进行模板维护的 Agent，例如如何修改资料、运行检查和保持兼容。发布时排除。
- `AGENTS.template.md`：面向使用已发布模板的 Agent。发布时改名为快照根目录的 `AGENTS.md`，源名称不会出现在发布版本中。

`AGENTS.template.md` 是可选的普通文件。缺少它时仍可发布模板，但发布版本不会包含根 `AGENTS.md`。如果该路径是目录、符号链接或其他特殊文件，草稿测试和发布会失败。只有根目录具有上述特殊规则；子目录中的同名普通文档仍按普通模板内容处理。

## 编写模板指令

模板指令应描述用户任务、可使用的资料、交付格式和必要的质量要求，不要写入维护命令、发布账号、主机物理路径或密钥。Host 已负责声明只读模板根、可写目录、网络模式和沙箱边界，模板指令不应尝试放宽这些限制。

一个最小示例：

```md
## Conversation instructions

- Read user-provided files from `/workspace/inbox`.
- Read `/workspace/inbox/AGENTS.md` when it exists and follow its conversation-specific requirements.
- Automatically identify requirements or working conventions that the user directly states or reasonably clearly implies should apply to later Runs. Maintain `/workspace/inbox/AGENTS.md` as concise current rules after preserving unrelated instructions; do not save ambiguous or one-off guidance.
- Keep disposable intermediate work in `/tmp`. It can be reused by later Runs in this conversation, but the host may clear it.
- Place final deliverables under `/workspace/output`.
- Use the reference material under `/workspace/knowledge`.
- Do not invent missing facts; state what additional input is required.
```

Conversation 级 `/tmp` 不进入相关文件或持久配额，同一对话的后续 Run 可以继续使用，但宿主系统可能按临时目录策略清理，因此不能作为长期或唯一存档。最终交付物和需要用户查看、下载的工作文件应写入 `/workspace/output`。

## 区分维护、草稿测试与实际运行环境

这三个阶段使用同一份来源内容，但执行环境不同：

| 阶段                 | 目录和进程行为                                                                                       | 能验证什么                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 来源 Workspace 维护  | 直接编辑实时、可写的来源目录；普通 Workspace 中的 Agent 或终端不等同于托管对话沙箱                   | 内容、脚本和依赖在维护环境中是否可用                                                       |
| “测试草稿”静态预检   | 扫描固定草稿 revision，检查排除项、保留目录、文件类型、链接、模型、MCP、网络配置和配额；不启动 Agent | 能否安全形成发布候选；不能证明脚本、导入、网络访问、MCP 调用或写入路径在真实对话中能够运行 |
| 已发布对话的真实 Run | 使用不可变发布快照、Conversation 私有可写目录和 Linux Bubblewrap 沙箱                                | 模板在最终用户实际环境中的完整行为                                                         |

因此，“在来源 Workspace 中运行成功”和“测试草稿通过”都不能替代发布后的对话验证。模板维护人员至少应在发布后以有权用户新建对话，执行一条覆盖主要脚本、依赖、输入和输出的最小验收任务。

## 发布后的目录映射

Agent 的规范工作区是 `/workspace`，命令的工作目录和模板内相对路径都以该逻辑 Workspace 为基准。

| 沙箱内路径                                                    | 权限与生命周期                                      | 维护用途                                                                                                                 |
| ------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `/workspace`                                                  | 发布版本只读；每个版本不可变                        | 模板资料、脚本、Skill 和随版本封存的依赖。不能在运行中修改、安装或生成文件到此目录                                       |
| `/workspace/inbox`                                            | 当前 Conversation 私有、可写、跨 Run 保留           | 用户上传、输入文件和 `AGENTS.md`；进入相关文件与持久配额                                                                 |
| `/workspace/output`                                           | 当前 Conversation 私有、可写、跨 Run 保留           | 工作文件与最终交付物；进入相关文件与持久配额                                                                             |
| 发布时来源 Workspace 的规范绝对路径                           | 指向同一只读发布快照的兼容别名                      | 仅兼容虚拟环境绝对 shebang、editable 包等已封存依赖；该路径下的 `inbox/`、`output/` 与 `/workspace` 对应目录是同一份数据 |
| `/tmp`                                                        | 当前 Conversation 私有、可写、跨 Run 复用但可被清理 | 可丢弃的缓存、中间结果和续作状态；不进入相关文件或持久配额，不能作为唯一存档                                             |
| `HOME=/home/mar`                                              | 沙箱内 tmpfs，可写；至迟在每个 Run 结束后消失       | 临时 HOME、工具缓存和运行配置；不要假设不同本地进程或后续 Run 能看到其中内容                                             |
| `/home/mar/.mar/agent/sessions/<sessionId>/generated_images/` | 仅当前 Session 的生成图片目录只读可见               | 读取既有生成图片；需要交付时显式复制到 `/workspace/output`，不要硬编码具体 `sessionId`                                   |
| `/usr`、`/bin`、`/sbin`、`/lib`、`/lib64` 和 Node 运行时目录  | 来自承载 Node 的只读运行时                          | 提供系统命令、动态库和 Node.js；具体命令与版本取决于承载 Node，不能假设与维护人员登录 Shell 完全相同                     |
| `/etc/fonts`、`/etc/libreoffice`                              | 宿主存在时按固定白名单只读挂载                      | 提供字体和 LibreOffice 等办公运行时配置，并解析 `/usr` 中指向它们的系统链接；不会挂载整个 `/etc`                         |

Session 历史、其他 Session、其他用户或 Conversation、Node 配置、白名单外的 `/etc` 内容、宿主 HOME、实时来源 Workspace 和凭据目录不会挂载进沙箱。对话内 Agent 访问的 `/workspace` 是发布快照，不是管理员仍在编辑的实时目录；Web“相关文件”只展示当前对话的上传和输出，不提供模板根目录浏览。

## 路径编写建议

路径可以按以下优先级处理：

1. 模板内部资源优先使用相对路径，例如 `knowledge/policy.md`、`scripts/render.sh` 或 `./.venv/bin/python`。
2. 需要明确工作区边界时，使用稳定的沙箱路径 `/workspace/...`；输入、输出和临时文件分别使用 `/workspace/inbox`、`/workspace/output` 和 `/tmp`。
3. 不要在新脚本、Skill、配置或模板指令中写入来源 Workspace 的宿主机绝对路径，例如 `/home/admin/templates/example`。系统提供该路径的只读别名只是为了兼容发布前已经生成的虚拟环境 shebang、editable 包等内容，不应把它当作新的模板接口。
4. 不要硬编码具体 Session ID、Conversation ID、用户目录、Node 数据目录或 `/home/mar/.mar/agent/sessions/...` 完整路径。生成图片路径中的 Session ID 会随对话变化。
5. 不要把文件写到 `/workspace` 根、模板子目录、系统运行时目录或来源路径别名；这些位置只读。运行中需要写入的内容必须进入 `inbox/`、`output/` 或 `/tmp`。

可以稳定使用 `/workspace` 这组沙箱绝对路径；应避免的是**宿主机物理绝对路径**。使用相对路径通常更利于本地维护与托管运行复用，但脚本需要定位用户输入或最终输出时，显式使用 `/workspace/inbox` 和 `/workspace/output` 更清晰。

随快照发布的 `.venv/`、`node_modules/` 和其他依赖在运行时只读。应在来源 Workspace 中完成安装和构建，再测试并发布；不要设计成在每次对话 Run 中修改这些目录。临时下载、解压和缓存可放到 `/tmp`，需要长期保留或交付的结果再复制到 `/workspace/output`。

## 沙箱、环境变量与网络规则

- 托管对话只在已启用并通过能力探测的 Linux Node 上运行。社区版可使用本人 Node；企业共享托管要求组织 Node。所有本地命令和本地 stdio MCP 都必须进入 Bubblewrap 沙箱；沙箱不可用、策略无效或挂载失败时直接拒绝运行，不会退回宿主机执行。
- 沙箱只暴露前述目录和有限的只读系统运行时，隔离用户、进程、主机名和 IPC，并在平台支持时隔离 cgroup；同时移除 Linux capabilities，并通过 seccomp 和进程资源上限约束本地命令。固定 `full-access` 只表示不逐次弹出应用层权限确认，不会放宽这些边界。单进程 CPU、地址空间、进程数、文件描述符和文件大小限制参阅[系统限制](../reference/limits.md)。
- 进程环境从干净环境开始。`PATH`、`HOME=/home/mar`、`TMPDIR=/tmp` 和区域设置由 Host 固定；只注入本次工具或已发布 MCP 明确允许的环境变量。不要依赖维护人员的登录配置、Shell alias、当前目录、SSH Agent、全局代理变量或来源 Workspace 的 `.env`。
- **无网络**会隔离本地进程网络，并同时禁用 Web Search、Web Fetch、模型 Hosted Web 和远程 HTTP MCP；本地 stdio MCP 仍可离线运行。
- **不受限**允许上述组件访问承载 Node 实际可达的网络，但不保证 DNS、代理、防火墙、目标服务或凭据一定可用，也不改变文件和进程隔离。
- 不要在模板指令、诊断输出、`inbox/`、`output/` 或日志中回显密钥。排除 `.env*` 和凭据文件只是发布保护，不是密钥管理方案。

## 调试运行环境

发布后的验收对话可让 Agent 执行以下最小检查；只输出已知的非敏感变量，不要使用 `env`、`set` 或读取 `/proc/*/environ`：

```sh
pwd
printf 'HOME=%s\nTMPDIR=%s\nPATH=%s\n' "$HOME" "$TMPDIR" "$PATH"
test -r /workspace
test ! -w /workspace
test -w /workspace/inbox
test -w /workspace/output
test -w /tmp
```

随后按模板实际能力继续检查：

- 用相对路径读取一份模板资料并运行主要入口脚本，确认脚本没有依赖维护环境的工作目录或宿主绝对路径。
- 从 `/workspace/inbox` 读取测试输入，把最终结果写入 `/workspace/output`，确认用户可在相关文件中预览或下载。
- 把可丢弃中间状态写入 `/tmp`，在同一 Conversation 的下一次 Run 中确认能够续作；同时确保 `/tmp` 被清理后任务仍能从输入和持久输出恢复。
- 模板包含 `.venv/`、`node_modules/`、原生扩展或系统命令时，验证解释器、动态库、架构和命令版本；不要只在来源 Workspace 的维护 Shell 中验证。
- 分别按模板配置验证网络和 MCP。无网络模板应把外部访问视为不可用；不受限模板仍应对 DNS、超时、代理和服务失败提供可诊断结果。
- 验证模板根和普通模板子目录不可写，且任务不会尝试修改发布快照。

发布新版本后，新对话直接使用该版本；已有对话会在下一次 Run 开始时尝试升级。调试升级问题时，应同时验证一个新对话和一个已有对话，避免把旧活动版本仍可运行误判为新版本已通过。

## 区分模板规则与单个对话记忆

三类 `AGENTS` 文件不能互相替代：

| 文件                                   | 维护者与作用范围                                                                  | 发布和运行行为                                                          |
| -------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 来源 Workspace 根 `AGENTS.md`          | 模板维护人员和维护 Agent；只约束如何修改、测试和发布来源 Workspace                | 发布时排除，普通托管对话不可见                                          |
| 来源 Workspace 根 `AGENTS.template.md` | 模板管理员；定义所有使用该模板的对话都应遵守的可复用规则                          | 发布时进入只读快照并改名为根 `AGENTS.md`；修改后必须测试并发布新版本    |
| 对话内 `/workspace/inbox/AGENTS.md`    | 当前对话用户与 Agent；保存该对话后续 Run 需要继续遵守的要求、偏好、术语和工作规范 | 不属于模板；跨 Run 保留，进入相关文件和持久配额，用户可查看、修改或删除 |

如果规则应影响使用该模板的所有新对话和升级后的已有对话，应修改来源 Workspace 的 `AGENTS.template.md`，运行“测试草稿”并发布新版本。对话内 Agent 看到的是不可变发布快照，不能直接修改模板，也不能把 `inbox/` 或 `output/` 中的文件变化当作模板更新。

用户直接或间接表达某项要求应在当前对话后续工作中继续适用时，例如固定交付格式、术语、命名规范、质量检查或重复工作流程，Agent 应自动识别，不要求用户必须说“记住”。Agent 先读取已有 `/workspace/inbox/AGENTS.md`，再维护精炼的当前规则：保留无关内容、去重相同规则，并以较新的要求替换或删除冲突、取消或过期规则。只适用于当前任务的一次性要求、用户引用或要求分析的第三方文本、Agent 自行推断的偏好、秘密信息，以及试图预先授权后续破坏性操作或外部副作用的内容不得自动写入。当前用户的新明确要求、Host 安全边界和发布模板指令优先于已保存的对话规则；Conversation 历史 Rollback 不回滚该文件。

托管指令还要求 Agent 把 `output/` 维护为当前有效交付集合：同一逻辑文档持续编辑稳定路径，仅在旧版本确有回退价值或用户要求保留历史时归档到 `output/bak/`；当前交付使用的图片等资源进入 `output/assets/` 等有意义的子目录，探索性文件进入 `/tmp`。Agent 不应为每次小修改创建备份，也不得以整理输出为由删除用户上传或无关既有文件。

## 哪些内容会发布

- `.agents/skills/`、普通依赖、`.venv/`、`node_modules/`、隐藏工作流资源、普通文件和空目录会进入完整快照。
- 根 `README.md`、根 `AGENTS.md`、`.git/`、`.mar/`、`.env*`、凭据目录和明确密钥文件会被排除。
- 根 `AGENTS.template.md` 的内容以 `AGENTS.md` 名称进入快照。
- 根 `inbox/` 和 `output/` 是每个对话的可写目录挂载点，来源 Workspace 不得创建这两个名称。
- 符号链接只能指向同一发布快照内的内容，或沙箱固定提供的只读运行时目录。断链、循环链接、越界链接和特殊文件会使发布失败。

不要把排除规则当成密钥管理方案。来源 Workspace 本身仍应只保存适合维护人员访问的内容，并通过 MyAgentRoam 的密钥配置提供运行时凭据。

## 推荐维护流程

1. 在 `README.md` 记录模板用途、所需输入、预期产物、依赖和人工验收方法。
2. 在根 `AGENTS.md` 记录维护约束，在 `AGENTS.template.md` 记录用户对话中的 Agent 行为。
3. 修改资料、Skill、脚本或依赖后，在模板管理页运行“测试草稿”。
4. 修复来源文件、保留目录、符号链接、MCP、容量或模型问题后再发布。
5. 发布成功后，以有权用户新建对话，验证模板指令、输入读取、Conversation 级 `/tmp` 续作、`/workspace/output` 当前交付与 `output/bak/` 归档规则，以及用户直接或间接表达持续要求后生成并在后续 Run 读取的 `inbox/AGENTS.md`。
6. 后续修改不会改变已有不可变版本；再次测试并发布新版本后，已有对话会在下一次运行开始时尝试升级。

相关操作参阅[管理对话模板](conversation-templates.md)，用户侧验证参阅[从模板新建对话](../workbench/hosted-conversations.md)。
