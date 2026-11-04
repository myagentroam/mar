---
title: 配置和使用 MAR Agent
lastUpdated: 2026-11-04
---

# 配置和使用 MAR Agent

MAR Agent 是随 Node 内置的编码 Agent，不需要安装外部 Agent CLI。每个用户都可在“管理 → MAR Agent 模型”添加和管理自己的个人模型；组织模型由有权管理员维护和授权。同时满足模型使用权和所绑定凭据作用域的用户即可在新会话中选择 **MAR Agent**。

Server、Web 和 Node 的版本切换及旧 Node 升级限制见[升级 MyAgentRoam](../deployment/upgrade.md)。

## 配置模型

模型表单中的 **上下文回收** 默认开启，可按模型关闭。关闭后不执行文本或图片 GC；自动 Compact 和图片请求硬限额仍生效，图片超限时请求会被拒绝。关闭配置需要运行 Node 声明支持该开关，旧 Node 不会静默忽略它。更改对后续执行生效。

“使用资源 URL”需要系统设置总开关与模型开关同时开启：全局默认开启，模型默认关闭，修改对下一次执行生效。当前用于图片视觉输入：开启时通过固定的 24 小时签名 URL 提供图片，过期不续期，不参与图片水位 GC；关闭时近期附件和工具图片保留在有界内联窗口，跨轮次继续可见。内联图片与文本共用 GC checkpoint：历史图片编码载荷超过 7 MiB 时，按最早顺序回收到不大于 5 MiB，保护最近两个成功模型轮次；文本 GC 时可顺带回收超过 5 MiB 的成熟图片。单次请求图片编码载荷上限为 12 MiB，必要时可越过历史图片保护期，但不丢弃本次新图。淘汰不删除附件或图片文件。图片附件仍保存为文件并提供路径；需要再次查看时，模型可用附件路径或当前会话的 `resourceId` 重新调用 `view_image`；释放提示会保留对应资源 ID。该工具每次返回图片尺寸，单张结果最多 3 MiB；较大图片可显式使用 `resize` 缩放或 `region` 查看局部，处理源文件最多 20 MiB。图片预算不包含文字和工具定义，不等于整个请求体大小。HTTP URL 与内联模式共用独立资源存储，关闭 URL 不关闭视觉能力。旧格式历史图片不再作为图像输入恢复，原文本与附件文件保留。图片策略要求 Node 支持资源输入能力。

每个模型都是独立连接。表单提供 **Codex**、**ChatGPT 套餐授权**、**X订阅 OAuth（实验性）**、**OpenAI Responses** 和 **Anthropic Messages** 五种连接类型。选择 Codex 后直接选择已有 Codex 凭据；模型 ID 始终手工填写或修改，不提供目录选项，也不要求该 ID 出现在所选凭据的实时模型目录中。切换凭据时已填写的模型 ID 会保留，展示名称仍可自定义。实时目录仅在“加载模型目录”批量导入时读取。Codex 使用固定服务地址，OpenAI Responses 与 Anthropic Messages 则分别填写 Base URL 和内联 API Key。新建模型的上下文 Token 默认 `256000`、最大输出 Token 默认 `32000`；切换连接类型保留模型 ID、Token 上限、能力、思考强度和用途等兼容字段。OpenAI Responses 与 Anthropic Messages 之间保留内联 API Key 和自定义 Base URL，仅默认地址随协议切换；临时切换到 OAuth 再返回也保留已填写的 Key 和自定义地址。OAuth 使用固定地址，不兼容的 OAuth 类型必须重新选择凭据。编辑已有模型时保留保存值，Key 不回显，留空保留已有 Key。目录导入优先使用上游明确提供的限制；缺失上下文 Token 时预填 `256000`，可在导入前修改，缺失最大输出 Token 时使用 `32000`（小窗口会收窄至严格小于窗口）。图片输入、会话标题命名、Code Mode、Hosted Web Search、Responses 续接、可选思考强度和默认思考强度都在模型表单中维护；所有 Responses 连接类型均提供传输选项。普通工作区会话和托管对话生成标题时，会按模型排序使用首个已启用“会话标题命名”的可用模型；没有模型开启时回退当前会话所选模型。默认思考强度始终必填；即使不向用户开放强度选择，MAR Agent 内部请求也会使用该默认值；Grok 未配置可选强度时，不向上游发送不受支持的 reasoning 参数。

在可管理模型的操作列选择 **复制**，会打开预填的新建表单，默认名称附加“副本”。可以修改配置、凭据和归属，选择 **保存** 后才创建新模型，取消不会写入。未替换的内联 Key 或兼容 OAuth 引用由 Server 安全复用，不向浏览器回显秘密。新模型使用独立配置 ID，追加到列表末尾，不继承共享授权和测试结果。复制仍须拥有源模型管理权，新模型的归属和凭据作用域在保存时重新校验。

Responses 模型（包括内联 API Key）可选择 WebSocket、HTTP/2 或 HTTP/1.1；X订阅支持 WebSocket 和 HTTP/1.1。选定传输失败时不会静默切换协议。HTTP 与 WebSocket 均可勾选服务端续接，切换传输保留勾选状态。只有开启续接的 HTTP 请求发送 `store:true`；未开启续接的 HTTP 和所有 WebSocket 请求均发送 `store:false`，不提供独立存储选项。开启 HTTP 续接时，首轮及引用失效后的完整回放也会请求上游保存响应，请考虑其数据留存政策。只在上游支持时启用续接。上游明确报告引用不存在或过期且尚未提交语义输出时，会在请求尝试预算内回退一次完整历史；鉴权、限流及无关错误不按引用过期处理。Adapter 重建或核心提示变化也会完整回放。HTTP 续接要求 Node 声明对应能力。Anthropic Messages 的多轮提示词缓存自动管理，无需该选项。

企业管理员在新增模型和 OAuth 目录导入时，可选择 **个人 / 组织** 归属。模型归属与凭据作用域独立：使用全企业凭据不会自动共享模型。需要共享时，先创建组织模型，再通过授权入口共享给用户、组织或全企业；个人模型没有授权入口。编辑已有模型只回显归属，不改变归属；已有个人模型需要共享时，应按组织归属重新创建或导入。模型列表直接展示完整的可管理集合，不分页；编辑、测试、刷新和删除后会重新展示当前完整结果。

MAR Agent 对符合条件的瞬时连接、服务过载或模型流错误进行有界重试；首次请求和后续重试共享最多 8 次尝试。已输出时保留已完成上下文继续恢复，不重置尝试计数。连续 3 分钟没有生成进展时会取消当前模型请求并进入同一恢复流程，心跳和元数据不会延长等待。该计时不包括客户端工具执行或人工等待；持续有生成进展的请求不设整体硬时限。

Responses 失败重试会重新发起模型服务请求，使用当前完整上下文，不沿用旧路由或服务端续接状态；WebSocket 会新建连接，但不会创建新的用户会话或运行。正常工具续轮仍保留当前路由和续接状态。单次模型请求耗尽重试后，对话错误会显示总尝试次数和重试次数，并保留最终错误原因；工具续轮或用户后续发起的新运行会从第 1 次重新计数，失败恢复本身不会重置计数。

MAR Agent 不设置单次运行的累计 token 预算或模型往返轮次上限，也不会因累计用量强制收尾。长任务可在 Context GC 或 Compact 后继续；上下文容量检查、取消与模型请求超时仍然有效。模型服务商的套餐、账户及请求限制不受影响。

工作区会话右下角的信息图标展示最近可用的 Latency 和平均输出 TPS。Latency 在收到首个有效模型语义响应后立即更新；平均输出 TPS 仅在请求结束、Provider 返回权威输出 Token，且累计生成观察时长至少为 1 秒时更新。不足 1 秒时不发布本次 TPS，但 Latency 和 Token 用量照常更新，同一 Run 内保留上一次有效 TPS。TPS 按客户端观测的生成区间计算，排除客户端工具执行和 Hosted Tool 的明确执行暂停区间；输出 Token 可能包含 reasoning 和 Tool Call，观测时长可能受网络和上游缓冲影响，不等同于模型服务端纯推理速度。

所有用户可在“我的模型顺序”Tab 按个人习惯调整当前获授权模型在选择列表中的顺序；该操作不会影响其他用户、管理员设置的默认顺序，也不会改变会话标题生成或模板候选。未被个人调整的新模型继续按管理员默认顺序排在后方。系统管理员在“模型”Tab 管理全局默认顺序，列表展示名称、连接类型、模型 ID、可用性、使用范围和测试状态，不展示凭据与 Responses 传输；Codex 传输仍可在模型编辑表单中查看和修改。删除模型不要求先禁用，也不会因当前正在使用而被阻止；已经开始的单次模型网络请求可自然结束，后续再使用该模型会按模型不存在失败。点击“调整排序”后拖动行首手柄，使用“保存排序”一次保存完整顺序并退出排序模式；“取消”会恢复调整前的顺序。

保存后使用“测试”，选择一个在线且版本、动态凭据能力和当前传输均兼容的 Node 执行真实最小请求。测试不会创建 Workspace Session 或 Run。测试成功或失败后弹窗都会保留，展示结果、错误码、HTTP 状态、消息、Server 请求 ID；如果 Node 提供上游明细，还会展示上游请求 ID、Content-Type、`Retry-After` 和可选择复制的纯文本响应正文。正文有安全长度上限，截断时会显示提示，HTML 不会执行或渲染。再次测试或改选模型、Node 会清除旧结果。失败测试仍按原规则显示错误通知，但诊断明细保留在弹窗中。列表和测试结果不会回显 API Key 或 OAuth Token；编辑时内联 Key 或已有 Codex 凭据留空表示保留原值。模型配置仍只由系统管理员管理；Codex 凭据则按凭据作用域由对应用户或管理员管理。

Codex (legacy) 和 ChatGPT 模型均提供 **速度 → 默认 / Fast / Ultrafast**。配置按 Responses 标准 `service_tier` 参数保存，适用于 HTTP 与 WebSocket 请求。存量 Fast 设置保留为 Fast，其余存量模型及新导入模型使用默认。可用性及额度消耗或费用由上游模型和账户决定，不支持时不会静默降级。独立 CLI 保留 `--fast-mode`、`--no-fast-mode` 兼容选项。

## 对话模型与辅助模型

模型表单默认勾选 **对话模型**。只有已启用且勾选此项的模型，才能出现在工作模式或托管对话的 Composer、Subagent 以及模板主模型候选中。取消勾选后，模型仍可用于专用 Compact、会话标题命名和输入预测；这些用途仍需分别配置并满足模型与凭据使用权。对话模型也可用于上述辅助用途，“启用”和“会话标题命名”开关保持独立。

MAR Agent 子会话的模型还必须勾选 **支持 Subagent**。子会话的模型选择只显示同时满足两种用途且当前可用的模型；没有符合条件的模型时，候选列表为空。主会话的模型选择不受此开关限制。

已有模型会保留对话用途，新建及目录导入也默认开启。修改不打断已开始的执行；后续发送、续作或显式选择不再具备对话用途的模型时会拒绝执行，请重新选择可用对话模型。历史记录不会删除。

## 输入预测模型

在 **管理 → MAR Agent 模型 → 高级 → Prompt Tab** 单独保存全局开关、模型和思考强度，不改变 Compact 配置。全局默认启用但不预选模型；用户仍须有模型及凭据使用权，可在 **设置 → 外观（Appearance）** 切换“输入预测”（无已保存偏好时默认开启，已保存关闭仍关闭；仅工作模式，选择立即保存到当前浏览器）。工作模式支持四种 Runner；预测通过 Node 调用 MAR Agent SDK 的独立模型接口，通过结果工具 Schema 接收预测数据，不创建 Agent 会话或执行工具。操作方式和数据范围见 [输入预测](../workbench/composer.md#输入预测-prompt-tab)。

## 专用 Compact 模型

系统管理员可在 **管理 → MAR Agent 模型 → 高级 → Compact** 配置启用开关、已有模型和思考强度。这是一份系统级配置，不在“系统配置”页面；企业默认优先选择根组织模型。默认关闭，关闭时继续使用当前会话模型整理上下文。保存只影响之后的运行，不切换当前正在执行的模型。

Node 扩展固定使用高密度 Textual Continuation IR 提示词，不提供模型级开关或独立 CLI 参数。IR 标题和字段名使用英文，自然语言描述可跟随任务语言。未启用或回退时使用 Core 普通结构化交接提示词。专用模型只生成内部交接摘要，不执行工具，也不改变会话主模型。普通会话和托管对话都需满足实际运行用户的模型使用权及凭据作用域；系统启用不会自动授予使用权。输入本地估算超出专用窗口时会在首次调用前裁到窗口的 90%，可能省略较早或冗长证据。专用模型不可用、仍超限或生成失败时，自动回退当前模型的默认整理；不对专用模型做二次容量裁剪或重试。取消或整理总时限耗尽不会触发回退。摘要仅供会话续作，不作为公开聊天正文展示。

MAR Agent 根据最近一次同模型的上下文输入用量安排自动整理：达到 85% 后在后台生成候选，当前任务和工具继续运行；达到 90% 后会在下一次模型请求前等待同一整理完成。会话时间线在同一项中更新后台生成、等待、完成、失败或取消状态；后台整理不会使当前任务提前结束，也不会公开内部交接摘要。快照之后产生的消息和工具结果会保留在整理后的前缀之后。成功整理后若仍有保留尾部，Context 用量在下一次前台模型请求报告新用量前保持未知；没有保留尾部则沿用现有 `0 / window` 重置基线。后台 Compact 用量仍计入成本，但不覆盖前台上下文用量、Latency 或平均输出 TPS。

Smart Compaction 可以在自然进入持续新工作阶段时提前请求同一后台整理机制。有效的同模型输入水位达到 60% 且低于 90% 时，Runtime 允许主模型判断旧阶段的详细上下文是否已失去主要续作价值；不会因每次切题或一次性问答就整理，也不保证无限历史无损保留。用量缺失或失效时跳过这次可选机会，固定 85%/90% 容量保护仍独立生效。无需额外开关或企业 License，SDK 与 CLI 使用同一机制；既有手动 Compact 入口和状态显示不变。

## ChatGPT 套餐授权

“OAuth 凭据”Tab 在同一张表展示 **Codex (legacy)**、**ChatGPT 套餐授权** 和 **X订阅**。添加 ChatGPT 凭据时选择 **ChatGPT 套餐授权**，再选择浏览器当前电脑上的在线 Node；该 Node 必须支持本机登录。打开本机登录入口，在 OpenAI 页面完成授权。选择远程 Node 无法接收当前浏览器的 loopback 回调，请取消并重新选择。

本机 Node 只作为临时登录器；最终凭据由 Server 保存和统一刷新。其他远程 Node 不需要参与登录，只要获授权就可共用该凭据。个人、组织和全企业作用域及管理/模型使用权限与 Codex 凭据一致。重新登录也需本机 Node，使用已签发的 client ID；取消或失败不会覆盖现有凭据。

模型使用固定的公开 OpenAI Responses 地址，不使用旧 Codex backend。支持 HTTP/1.1、HTTP/2 和 WebSocket；HTTP 与 WebSocket 均可启用 `previous_response_id`，在用户与工具多轮间增量续接；WebSocket 额外要求同一健康连接，重连或 Adapter 重建后回放完整必要历史。不支持以此凭据调用图片生成。可选 SOCKS5 同时用于 Node 登录、Server 刷新与目录，以及运行 Node 的模型请求。

身份登录成功但缺少套餐使用权限时，凭据会保留并明确显示“未授权”，不能加载目录或用于模型；请重新登录并授予套餐使用权限。该状态不等于 Token 失效，也不会自动改用 API Key 计费。新凭据不提供旧 Codex 私有用量查询，账户标识来自已验证身份；目录没有提供的上下文窗口需在导入时补齐。Token 不会返回管理页面。

在 ChatGPT 凭据的**详情**中选择**管理用量**，会在新标签页打开 [ChatGPT 设置 → 用量](https://chatgpt.com/settings/usage)，查看套餐或本应用的限制并调整可用设置；请确认 ChatGPT 当前登录的是该凭据对应的账户。收到 `subscription_sharing_usage_limit_exceeded` 时，聊天错误消息会用纯文字提示用量限制，以及需要打开的 `https://chatgpt.com/settings/usage` 地址，不提供额外按钮或链接交互；普通 429 不会被当作套餐额度耗尽。

## X订阅 OAuth（实验性）

在“OAuth 凭据”中选择“添加 OAuth 凭据”，类型选择 **X订阅 OAuth（实验性）**，填写名称、归属和可选 SOCKS5 URL。打开显示的 xAI 授权页面并输入设备码；不需要选择本机 Node。请确认授权页面与要绑定的账户后再同意。共享公共 OAuth 客户端可能显示 Grok Build 名称；是否允许推理取决于上游账户和订阅资格，付款金额或登录成功都不保证模型访问权。

代理格式为 `socks5://[username:password@]host:port`，特殊字符需要 URL 编码。Server 的设备码、Token 换取、身份查询、刷新、目录、额度和撤销请求，以及执行 Node 的模型请求，均使用这份配置；代理不可达时不会回退直连。Server 和执行 Node 都必须能访问代理地址，远程 Node 上的 `127.0.0.1` 不是 Server 本机。打开 xAI 授权页使用浏览器自身网络，不继承此代理。创建后可在凭据编辑中修改或清除代理，详情中可原样检查完整 URL；请勿公开截图中的代理密码。

登录成功后可以加载模型目录导入，也可以新建 Grok 模型并选择已有凭据、填写模型 ID。模型推理固定使用 `https://cli-chat-proxy.grok.com/v1`，提供 WebSocket 和 HTTP/1.1 SSE 传输选项，新建与目录导入默认 HTTP/1.1 SSE，编辑时可切换传输；Responses 续接默认关闭，此时两种传输均发送完整历史；两种传输均可手动开启 `previous_response_id`，实际支持由上游及账户决定，开启不代表兼容性保证。订阅代理的传输与续接支持不作保证；引用不存在时会回退一次完整历史，其他失败保留错误诊断。不提供速度档位、HTTP/2 或图片生成。仍使用 X 订阅 OAuth 凭据，不要求开发者 API Key；目录、身份与额度查询继续使用订阅代理。升级 Server 时会自动将误配置为开发者 API 地址的订阅模型迁回订阅代理，保留其他配置并清除旧测试状态。Hosted Web Search 可在模型表单开关，新建和目录导入默认开启；已有模型保持原配置，需编辑勾选并保存才会开启。重新导入会创建独立模型，不修改已有模型。执行 Node 必须支持新的 Responses 参数能力，否则需要升级 Node。

在凭据详情中点击“查询用量”，可手动查询本周期已用/剩余百分比、周/月周期、重置和查询时间，以及单独列出的额外美元余额。缺失值显示“—”，不是 0 或无限；不推算剩余 Token，不展示不存在的 Token 统计。查询失败不代表推理不可用；用量不会自动轮询，关闭详情会清除结果。上游可能存在额外付费余额，MAR 不自动充值或更改计费设置，也不保证订阅调用永不产生额外费用。

Token 由 Server 保存并自动刷新，执行 Node 只取得短期访问凭据；失效时可重新登录。删除未被模型引用的凭据会尽力撤销上游 refresh token，撤销失败会明确提示。此接入依赖可能变化的订阅代理协议，不建议用于要求稳定 SLA 的生产任务。

## 配置 Codex 凭据与模型目录

所有用户都可从“管理 → MAR Agent 模型”进入“我的模型顺序”和自己有权管理的 OAuth 凭据视图；只有系统管理员会看到用于配置模型的“模型”Tab。选择“添加 OAuth 凭据”并选用“Codex (legacy)”时，普通成员只能创建个人凭据，组织管理员还可选择其管理组织子树内的组织凭据，系统管理员可选择组织或全企业凭据。个人凭据仅所有者可见，组织凭据仅系统管理员和覆盖该组织的组织管理员可见，全企业凭据仅系统管理员可见。填写名称、作用域及可选 SOCKS5 代理后开始设备登录；该代理仅用于 Codex OAuth 请求、模型目录请求，以及引用此凭据的 Codex 模型请求。系统显示设备码和验证页面，并按服务端间隔自动轮询；等待期间也可选择“刷新登录状态”立即查询一次。只有登录成功、Token 交换及账户校验完成后才保存凭据。取消、失败或过期的登录不会创建凭据。

凭据列表和详情分别展示当前 access token 的到期时间和 ChatGPT 上游给出的最早可刷新时间；未知的最早可刷新时间显示“—”，这两个时间都不表示 refresh token 到期。refresh token 仍有效且授权正常时，Server 会自动在临期换码；长时间运行任务的 Node 也会自动续取访问令牌和运行票据，不依赖下一次模型调用。暂时失败或返回的令牌仍临期时有界重试；持续断线或凭据失效仍需恢复连接或重新登录。手动刷新可以提前请求换码，是否成功以上游响应为准；自动续期仍遵守最早可刷新时间。真正换码成功后，列表和当前详情立即显示新的到期时间、最早可刷新时间与最近刷新时间。操作列提供“详情”“编辑”“测试”和“删除”。选择“编辑”可修改名称、作用域和 SOCKS5 代理。缩小凭据作用域时，如果已有模型授权超出新作用域，保存会被拒绝，需先收窄模型授权。详情会单独读取并原样显示当前凭据的完整 SOCKS5 URL，并提供刷新、重新登录、查询用量和加载模型目录。选择“查询用量”后，页面显示总 Token、上一日用量、连续 7 个自然日 Token 合计、当前限额窗口的已用百分比、重置时间、本次查询时间；上一日的具体日期与 UTC 偏移以小字显示在用量数值下方。即使昨日没有统计桶，也显示该日期，用量显示为“—”且不回退到更早日期；最新桶若为当地当天，仍不计入 7 天合计。统计日按 `America/Los_Angeles` 换日：夏令时为 `UTC-07:00`（UTC+8 的 15:00），冬令时为 `UTC-08:00`（UTC+8 的 16:00）。系统不会自动轮询，关闭详情后也不会保留完整代理串或用量结果。被模型引用的凭据必须先解除引用才能删除。页面不会展示自定义元数据、已导入模型数量、access token、refresh token、ID token、上游原始用量响应或 FedRAMP 标记。

选择“加载模型目录”会实时读取该凭据可见的 Codex 模型。页面逐项显示系统支持的思考强度（包括 `ultra`）、目录提供或系统归一化后的默认强度，以及真正未知的上游强度。勾选要导入的条目；只有上游未提供上下文窗口时才需要补齐，缺失最大输出不会生成输入项。目录不提供可用状态开关，导入后的模型默认启用并采用目录默认强度；传输方式和 Responses 续接等设置统一在模型视图中调整。Codex 和 ChatGPT 每次从目录导入都会创建新的独立模型，即使凭据、上游模型 ID、展示名称和归属完全相同。已有模型和授权保持不变；新模型使用导入默认配置，不继承已有模型的设置或授权。目录发生变化时页面会要求重新确认。

## 配置使用授权

新建模型默认为“受限”，升级前已有模型会迁移为“公共”。模型列表的“使用范围”列显示当前状态：

- 向“整个企业”授权后，模型成为公共模型。
- 未向整个企业授权时，可分别授权给用户或组织，模型保持受限。
- 系统管理员始终可以管理全部模型，不受模型授权记录限制；实际使用仍必须位于模型所绑定凭据的作用域内。

点击模型行的“授权”可查看、添加或撤销授权。模型授权范围必须完全包含在所绑定凭据的作用域内，例如组织凭据不能授权给该组织子树以外的用户、组织或整个企业。普通用户的新会话模型目录只显示同时满足“已启用”“当前用户有模型授权”和“当前用户位于凭据作用域”的脱敏模型；主 Agent 和 subagent 使用同一份授权模型集合。

禁用模型后，后续新会话、消息和会话命令会被拒绝。撤销用户权限、用户离开凭据组织作用域、模型改绑或解绑凭据、凭据失效后，运行时也会在每次解析动态凭据时重新拒绝后续请求；Node 已经接收且不再需要解析凭据的工作不会被强制中止。再次打开已有 MAR Agent 对话时，如果原模型已不在当前可用目录且目录仍有模型，Web 会自动保存目录中的第一个模型，并把思考强度切换为该模型的默认值；目录为空时不会切换到其他 Agent。模型可直接删除，无需先禁用或等待活动任务结束；已经取得配置的执行可继续，后续解析该模型将按不存在失败。

## 会话与权限

Node 提供 **Auto** 和 **完全访问（Full access）**。新建普通工作会话默认 Auto；已有会话保留保存的档位，进入 Goal 不会把 MAR Auto 自动升级为完全访问。独立 SDK/CLI 仍默认 Full access，托管对话保持原有隔离与权限策略。

Auto 由当前模型判断：普通工程操作和已明确授权的任务自动继续；重要风险或授权仍无法判断时 ask；deny 仅用于仍然有效的明确禁止、上级/Host 禁止或已知无法合理限制影响的极端危险。相同任务、目标和影响范围内的授权会继续复用，不因换工具、重试、分轮或子 Agent 反复询问；范围、影响扩大或用户撤回时重新判断。

Code Mode 由模型优先在外层 `code_exec` 整体声明 ask/deny。内部 deny 只拒绝该次工具调用，在结果 `data` 中返回 `error: MAR_AGENT_PERMISSION_DENIED` 和简短 `message`，不抛出 JS 异常或结束整段代码；后续依赖步骤应先检查返回结果。该工具仍记录为失败，其他异常保持原有处理方式。

ask 通过 Runner 审批卡在线等待，显示公开原因、命令/参数/代码、工作目录与到期时间。点击允许后执行已捕获的原调用；多个请求分别审批。10 分钟未决定即过期，不执行，也不视为用户拒绝。拒绝、过期和模型 deny 仅使该次调用失败，模型可在剩余授权内继续或自然停止；不能自动重试或绕过用户拒绝。取消后、已决定或过期的卡片不可执行。Goal 与定时任务沿用 Node 现有策略。无在线通道的独立 SDK/CLI 在 ask 时停止；之后的新指令不会重放旧调用。

**Auto 不是操作系统沙箱，也不是独立安全审查器。** Full access 不做 Auto 自评，两种档位都保留 Host 路径与资源校验，工具使用 Node 服务账号的实际权限。请使用低权限专用账号并限制 Workspace 和主机权限。

原生会话记录保存在 Node 运行账号的 `~/.mar/agent/sessions/`。Server 不保存会话正文。MAR Agent 支持 Plan、Compact、question、Todo、MCP、图片和 subagent。每个 subagent 都是独立持久化的子会话，保留自己的历史和父子关系，但默认会话列表只显示用户根会话；Agent Network 支持根会话、子会话和孙会话三层，不支持第四层。目标模式由 Node 的统一 Goal 流程管理，不在 Agent SDK 内重复实现。

MAR Agent 会扫描 HOME 与工作区中的标准 Skill 目录，先向模型提供名称和用途摘要；用户请求明确命中某个 Skill 时，再加载该 Skill 的完整工作流和资源目录。无需在请求中写出 Skill 名称。 同名技能按 Workspace、用户、SDK 内置的顺序选择；项目可以定制指导，但不能改变工具参数或主机权限。

### 命令执行环境

`exec` 默认启用登录配置。Bash 按原生顺序读取首个可读的 `~/.bash_profile`、`~/.bash_login` 或 `~/.profile`，并在 `BASH_ENV` 未设置或为空时补加载可读的 `~/.bashrc`；PowerShell 默认加载启动配置。配置属于执行命令的 Node 服务账号，不是浏览器用户。每次命令启动都会重新读取配置；托管对话只读取隔离环境中可见的文件，不加载宿主账号的配置。

需要跳过登录初始化时，可以让 Agent 使用 `exec({ command: "…", login: false })`。登录 Shell 仍是非交互模式：如果工具链 PATH 位于 `.bashrc` 的非交互 `return` 后面，应将这类通用环境配置放到登录配置中，或移到该提前返回之前。MAR 不会绕过这个保护，也不会把一次命令中的 `export` 写回 Node 或后续独立命令。

### 子 Agent 高级控制

Node Agent Network 不设置旧的 16 个创建或并发限制；独立 SDK Subagent 扩展保留自己的准入策略。

协作工具为 `agent_start`、`agent_send`、`agent_wait`、`agent_stop`、`agent_list` 和 `agent_view`。`agent_start` 使用文本任务和非空标题，登记子会话和首个执行后即返回，不等待完成；手动 marctl 创建时标题可省略。使用结果中的 `agentId` 寻址子会话。`agent_send` 可发送文本消息、更新 Goal 或对获授权会话的审批作决定；可指定投递意图，包括替换当前执行。`agent_wait` 默认等待直接子会话终态 30 秒，`waitMs=0` 只查看快照，正数按传入时长等待。`agent_stop` 只需会话 ID，停止目标当前执行并清除 Goal；列表和查看工具用于发现获授权的会话及其状态。

`agent_view` 仅接受 `agentId`，返回状态、当前 Goal 和有界最近活动，不公开 Run 或 Execution ID，不读取会话历史。完整记录通过独立的 `marctl agents history <session-id>` 按需分页查询；`marctl agents view` 遵循相同的状态查询边界。

目标空闲且没有当前或保留执行时，`agent_wait` 返回 `AGENT_IDLE`，摘要明确说明“Agent is idle; there is no execution to wait for.”，不表示会话不存在或任务失败。空闲会话若仍保有真实终态执行，则正常返回该执行结果。省略目标且没有子会话时返回 `AGENT_WAIT_NO_TARGETS`；显式目标不存在时返回 `SESSION_NOT_FOUND`。等待不会启动空闲会话。

同一获授权 Node/Workspace 内，消息、显式等待、Goal、停止、审批及 marctl 会话设置均不按父子关系限制；目标 Run/队列用户归属、模型及资源授权仍有效。发送不建立横向自动订阅。

子 Agent 的未读公开消息与新终态会在父 Agent 下一次正常模型请求前自动送达，包括原生 Extension API 创建的直接子 Agent；父 Agent 无需反复使用 message wait 检查进展。自动送达不唤醒空闲父 Agent，也不延迟正常最终回复；交付所必需的结果仍应在结束前主动汇合，真正阻塞时仍可使用 `agent_wait`。自动送达与模型的显式等待共享已读位置，因此已经送达的正文或终态证据不会在后续等待中重复返回。子 Agent 的内容是待核验的上下文，不是新的用户指令或授权。

Node 原生 `agent_send` 使用 `delivery` 参数，取值为 `STEER` 或 `QUEUE`。携带正文时，省略该参数默认使用 `STEER`；纯 Goal 更新或审批操作不受影响，公共消息接口和 CLI 的默认值不变。其他 Runner 使用 `marctl agents send <id> --steer -m <text>`。及时沟通建议优先使用 STEER；QUEUE 更适合用户或接收方明确要求延后的输入。输入要等当前工作和前面的队列项结束后才消费，有活动 Goal 时，必须等到该 Goal 退出才消费。已接收不保证立即处理。

消息被接受后，通常无需另外回复或索取收悉确认，也不必仅为确认收到而立即查看会话。主、子 Agent 建议并行推进有意义且不重叠的工作；没有其他本地工作可做，且需要结果解除阻塞或收尾时，再考虑等待。必要的任务结果、澄清、阻塞、冲突和决策信息仍应正常交付。

原生 `agent_list` 只接受 `scope`、可选标题片段 `query` 和 `limit`。省略 `scope` 或选择 `tree` 时，返回当前会话所在的协作树，包括已登记且获授权的根、祖先、同级及后代；空闲及已结束执行的会话也保留。选择 `active` 时，返回当前 Workspace 内正在运行或睡眠的会话，不把最近聊过、Goal 已启用或队列非空当作活跃。已知会话应直接复用其 ID，不按标题自动选址或派发。

`query` 在选定范围内按标题片段过滤，忽略首尾空白及大小写，并统一全角等兼容字符；`limit` 默认 10、上限 100。结果为 `currentAgentId`、扁平 `sessions` 和 `truncated`，每项只含 `id`、`parentSessionId`、`title` 和 `status`（`RUNNING`、`SLEEPING` 或 `IDLE`）。两种范围均按活跃优先、最近活动时间倒序排列，通过 parentSessionId 保留树关系；父项可能因过滤或授权不在结果中。无匹配返回空列表，超过 limit 时标记截断，不提供 cursor 或翻页；可用 query 缩小范围。列表不扫描 Runner、不恢复执行、不自动订阅。`marctl agents list` 使用相同参数和返回字段；独立终端没有当前会话时默认 active，currentAgentId 为 null，显式 tree 会报缺少会话上下文。

```js
await tools.agent_list({});
await tools.agent_list({ scope: 'active', query: 'review', limit: 20 });
```

`sleep({ durationMs })` 提供有界定时等待，时长必须为 1 至 1800000 的整数毫秒（最长 30 分钟）。已接受的用户补充或子 Agent 未读公开消息会提前唤醒；消息随后沿正常路径自动注入并标记已读，不会重复唤醒。它不会监测外部条件，也不会因进程或 cell 完成而唤醒；已有资源应使用对应的 wait。`sleep` 始终由模型直接调用，不可在 Code Mode cell 内调用。

`agent_wait` 也支持指定一组子 Agent：

```js
agent_wait({
  agentIds: ['a', 'b', 'c'], // Replace with IDs returned by agent_start.
  mode: 'all',
  waitFor: 'completion',
  waitMs: 300000
});
```

`agentIds` 必须包含 1 至 8 个不同 ID，不能与 `agentId` 同传。`mode: 'any'`（默认）等待任意一个满足条件，`mode: 'all'` 等待全部；`waitFor: 'completion'`（默认）等待终态，`waitFor: 'message'` 等待每个目标的最新未读公开消息或终态，普通工具活动不会唤醒。失败、取消和中断也属于终态，不代表任务成功。批量等待共用一次超时，返回按输入顺序排列的 `agents`、集合 `waitOutcome` 和尚未满足条件的 `pendingAgentIds`；超时可以返回部分结果。`waitMs=0` 只返回状态快照，不读取或消费未读消息。取消等待不会停止子任务。单 Agent 和省略目标的调用方式保持不变。

### Web 搜索与抓取

开启 Hosted Web Search 时，Auto 与 Full access 均使用所选模型服务的原生托管搜索，不需要客户端 permission 声明，也不同时提供自托管搜索；关闭时使用 Server Compose 内置 SearXNG。Web Fetch 由 Node 本地直连执行，不读取模型凭据，也不会继承 Codex 凭据配置的 SOCKS5 代理；它可访问 Node 网络可达的任意 HTTP/HTTPS IP 或域名（包括内网），并默认接受自签名或其他不受信任的 HTTPS 证书。如需严格校验证书，在 Node 服务环境设置 `MAR_AGENT_WEB_FETCH_ALLOW_UNTRUSTED_TLS=0`。

Web 工具由 Node 宿主按本次执行注入，不是 Agent SDK 的内置网络能力。`web_search` 返回有界的搜索片段；`web_fetch` 通过 Chromium 打开 URL，或使用页面引用继续阅读、按字面文本查找。HTML 转换为有界 Markdown 阅读窗口，引用和续读游标显示在工具结果中；引用仅在当前会话可用，失效后需重新打开 URL。网页内容是不可信的外部数据。每个 Node 最多同时抓取 4 个页面；容量满时按先来先服务排队，不立即报繁忙。排队、浏览器轮换和抓取共享 30 秒总超时，超时后才返回超时错误；取消会移除对应等待请求。HTTP 错误、网络失败、超时或不可读页面只在该次请求结果中报告，不因一个网址失败取消其他独立请求；参数、权限、执行取消和运行环境异常仍按调用错误处理。共享 Chromium 空闲 30 分钟后关闭，运行满一小时后等待现有抓取结束并关闭；轮换期间的新请求也排队，之后按需重新启动。子 Agent 的搜索目录按其实际选择的模型投影，不沿用父模型的选择。浏览器不共享用户登录态或 Cookie，不提供点击、登录、任意脚本和下载接口，也不自动回退到其他抓取后端。托管对话的 `NONE` 网络策略不提供两种 Web 工具；允许联网的托管对话始终严格校验 HTTPS 证书。

Node 安装/升级时自动准备 Chromium，启动和抓取时不下载。浏览器不可用时检查服务账号的缓存与 Linux 系统库，详见[安装与注册 Node](../deployment/node-installation.md#web-fetch-浏览器准备)。

## 图片生成配置与使用

### 配置图片模型

每个用户都可在独立的“图片生成”Tab 添加、启停、编辑或删除自己的个人图片模型；组织图片模型由有权管理员维护和授权。

选择“调整排序”后拖动排序手柄改变优先级，点击“保存排序”后生效；“取消”会恢复原顺序，排序期间不编辑其他配置。

Codex 配置凭据和模型 ID；火山方舟配置 API Key、模型 ID 和完整的图片生成接口 URL（文生图和图生图共用）。模型 ID 和 URL 不提供默认值，须手动填写；URL 使用 HTTPS，不包含认证信息、查询参数或 fragment。已有 Ark 配置需补齐 URL 后才能使用。Ark Key 保存后不回显，编辑同一项时留空保留。

### 请求生成或编辑图片

系统管理员保存图片模型目录后，每个 Run 按顺序只选择首个已启用且当前用户可用的图片模型：Codex 要求用户位于凭据作用域且凭据无需重新登录，Ark 要求已配置 Key。不可用项会跳过；全部不可用时仍可进行文本任务。配置变化从下一 Run 生效，请求失败不会自动切换供应商。无论当前使用 Codex、OpenAI Responses、Anthropic Messages 或纯文本 coding 模型，只提供所选 Provider 对应的 `codex_image_gen` / `codex-imagegen` 或 `byted_ark_image_gen` / `byted_ark-imagegen` 工具与 Node 提供的 Skill，不并列启用两套，仅根 Agent 可用，Subagent 不获得这些工具。两者支持文生图和参考图编辑；Ark 固定单图、2K、PNG，不支持组图。你可以直接请求生成或编辑图片，无需安装 Skill 或指定其名称。Agent 的提示要求先加载该 Skill，再进行你请求或明确授权的图片操作；不应仅因任务可以配图就主动增加生图工作。Skill 最初只以名称和用途摘要进入上下文，完整指导按需加载，不会在 HOME 或 Workspace 创建技能文件，也不提供额外的 Python CLI 或 API Key 备用流程。

## Code Mode 工具编排

六个 Agent 协作工具均支持直接调用和 Code Mode 内的 programmatic 调用。启用 Code Mode Only 后，它们通过 cell 使用，不额外保留双入口展示；子 Agent 自身按所选模型的配置使用 Code Mode。

Code Mode 默认关闭。只有在模型配置中开启 **Code Mode** 且 Host 提供执行能力时，MAR Agent 才向模型提供受限 JavaScript 编排入口；主 Agent 和选择其他模型的 Subagent 分别使用各自模型的开关。协议类型不会自动决定支持情况。模型可在一段代码中组合多个允许的工具调用并只返回需要的结果，以减少中间模型往返。 开启后默认采用 **Code Mode Only**：支持编排的工具（包括单工具操作）默认经 `code_exec` 调用，direct-only 工具及明确支持双边展示的工具保留直接入口；关闭时恢复普通直接调用。Only 控制模型可见入口和调用引导，不新增权限限制；运行时仍按工具调用权限、发现状态和 Host 策略处理。修改配置从下一次执行生效，不改变正在运行的执行。

开启 Code Mode 时，`apply_patch`、`exec` 和 `exec_wait` 同时保留直接调用和程序化调用入口。`apply_patch` 和 `exec` 由模型按任务自主选择；单进程纯等待优先直接调用 `exec_wait`，并行等待或组合处理仍使用 `tools.exec_wait`。不要通过两种入口重复等待同一进程。其他工具的默认展示策略和原有调用权限不变。

每个 cell 使用全新的 QuickJS WASM Runtime，由 Host 管理独立工作进程。支持顶层 `await` 和 `Promise.all`，不提供 Node 全局对象、模块导入、原生文件/网络 API 或 `console.*`。使用 `observe.result(result)` 登记未经修改的完整工具结果或捕获的工具错误；对派生值使用 `observe.text(value)`，对图片使用 `observe.image(value)`。观察只选择传给模型的证据，不代表已经读取或检查；没有 `out` 别名。文件、命令、网络等操作只能经显式允许 `programmatic` 的 `tools.NAME(input)` 调用，并保留工具自身的权限和安全检查。工具结果是统一 envelope，原始文件文本取 `result.data.results[0].text`，而不是带行号展示的 `content`。

`code_exec`、`code_exec_wait`、`tool_search`、`question` 和 direct-only 工具不能在 cell 内调用。普通外部 MCP 默认具备 programmatic 权限，开启 Only 模式时通过 Code Mode 调用，显式 direct-only 工具仍直接调用。需发现的工具先直接调用 `tool_search`；搜索结果提供名称、说明和输入定义，不持续改写 Code Mode 描述，只有已发现且获准 programmatic 的工具才可在下一模型请求的 cell 使用。所有工具调用必须等待完成。语言隔离不替代 Host 的文件权限、进程与操作系统沙箱策略，也不使有写入权限的工具变为只读。输入和文本输出各限 1 MiB，每 cell 最多 128 次工具调用；同步 JavaScript 执行预算为 120 秒，异步工具等待不消耗该预算，cell 不设固定墙钟总时限。取消、超时或结果超限可能发生在部分操作完成之后；失败不会回滚已完成修改。后台进程可直接用 `exec({ command, ... })` 或 cell 内的 `tools.exec({ command, ... })` 启动；返回 `processId` 后通过 `exec_wait` 或 cell 内的 `tools.exec_wait` 控制，默认等待，也支持 `action: "write"` 与 `action: "cancel"`。两个进程工具均支持 direct 和 programmatic，Only 模式下也均保留双入口。cell 内等待仍遵守工具自身超时及 Host 策略。`exec` 不接受旧的 `action` 参数。首次等待默认 10 秒、最多 30 秒，`exec_wait` 默认 10 秒、最多 300 秒；显式 `yieldMs: 0` 立即返回。取消等待不会终止进程，等待窗口也不会延长执行总超时。

后台 cell 属于 Session 温资源。`code_exec` 首次默认等待 30 秒，`code_exec_wait` 默认等待 10 秒；显式等待值不改变内部工具的等待窗口。`cell.yield_control()` 只结束当前等待并返回已有输出，JS 继续后台执行；也可通过首行 `// @options: {"yieldMs":30000}` 设置首次等待窗口；输出预算由 Runtime 固定控制。返回 `cellId` 后直接调用 `code_exec_wait` 获取增量或终态，`action` 默认 `poll` 等待，传 `action: "cancel"` 才显式终止。当前 Execution 结束或取消不会终止已登记的 cell；后续 Execution 可从保留资源提示接管。Session 资源回收、超时或 Host 退出会终止 cell，进程重启不恢复 JS 执行状态。终态结果仅有界缓存，重复领取带 `cached: true`。

临时资源句柄带类型前缀：`cellId` 为 `c_` 加 12 位小写十六进制字符，`processId` 为 `p_` 加 12 位小写十六进制字符。请完整原样使用工具返回的 ID，不要截断或互换。cell 仅通过 `code_exec_wait` 接管，进程仅通过 `exec_wait` 控制；传错类型会返回 `MAR_AGENT_RESOURCE_HANDLE_TYPE_MISMATCH` 和对应工具提示，不会自动转调。前缀不代表资源仍存活或有权访问，原有 Session 归属和清理规则不变。

进程等待会在窗口内聚合 stdout/stderr，直到进程完成输出收尾或等待到期；新日志不会提前结束模型等待。Web 命令卡可实时显示有界日志预览，不增加模型往返，也不消费最终工具输出。取消与用户补充仍可提前结束等待，进程继续运行。

Web 会话将整次 `code_exec` 展示为命令卡，保留原始 JavaScript 和本次调用输出，不拆解内部工具；内部进程的实时日志在外层代码卡上显示，cell 返回 running 后由同次执行的活动等待卡接续显示，最终以本次正式工具结果为准。`code_exec_wait` 同样以命令卡显示等待或取消结果；命令卡返回不表示 yield 后的后台 cell 已结束。

## 本地 SDK 与 CLI

`@myagentroam/agent` 可作为 TypeScript SDK 直接嵌入，也提供唯一命令 `maragent`。CLI 使用当前用户 HOME 下的 MAR 自有模型目录，不读取 Server 模型配置，也不会自动发现 Claude、Codex 或 OpenCode 配置。模型可配置为静态 API Key 或 `CODEX_AUTH_FILE` 凭据来源；仅当用户为当前命令显式传入 `--codex-auth-file PATH` 时，CLI 才只读加载该 Codex ChatGPT OAuth 文件。文件路径和 Token 不会写入模型目录、Session、日志或事件，CLI 也不会刷新或回写该文件。使用 `maragent --help` 查看运行、恢复、会话和模型管理命令。

独立使用时先安装包，再用 `maragent models list` 检查当前账号的本地模型目录；模型登记与运行选项以 `maragent models --help` 和 `maragent --help` 为准。CLI 的命令和 Agent 工具以运行账号权限执行，先选用专用账号和可信工作目录，不要在生产目录试运行。

独立 CLI 默认加载 Subagent 扩展。新模型默认可用于对话，但不自动用于子会话；使用 `maragent models edit <id> --subagent-model` 显式启用，`--no-subagent-model` 关闭。子会话模型必须同时启用 conversation 和 subagent，用途可通过 `models list` 查看，也可在 `models add/edit` 中使用 `--conversation-model` 或 `--no-conversation-model` 设置。

SDK 最小示例使用一个兼容 OpenAI Responses 的端点。先按供应商的真实模型能力调整 URL、模型 ID 和 token 限制；设置 `MODEL_API_KEY`、`MODEL_BASE_URL`、`MODEL_ID`、`AGENT_HOME` 与 `WORKSPACE` 后运行。`session.run` 会发起真实模型请求，也可能执行工具；仅在有权限的隔离环境使用，密钥不要写入源文件或提交。

```ts
import { createAgent, SecretValue, type AgentModelConfiguration } from '@myagentroam/agent';
import { LocalAgentHost } from '@myagentroam/agent/host';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}`);
  return value;
}

const home = required('AGENT_HOME');
const workspace = required('WORKSPACE');
const model: AgentModelConfiguration = {
  id: 'example',
  name: 'Example',
  protocol: 'OPENAI_RESPONSES',
  baseUrl: required('MODEL_BASE_URL'),
  apiKey: new SecretValue(required('MODEL_API_KEY')),
  modelId: required('MODEL_ID'),
  contextWindowTokens: 128000,
  maxOutputTokens: 4096,
  inputCapabilities: ['TEXT'],
  outputCapabilities: ['TEXT'],
  reasoningEfforts: [],
  hostedWebSearch: false,
  titleGeneration: false,
  codeMode: false,
  enabled: true
};
const agent = await createAgent({
  mode: 'normal',
  host: new LocalAgentHost({ homeDirectory: home, workspace }),
  models: [model]
});
try {
  const session = await agent.createSession({ workspace, title: 'Example' });
  const result = await session.run({ prompt: 'Summarize this workspace.' }).result();
  console.log(result.status, result.finalAnswer);
} finally {
  await agent.dispose();
}
```

该示例只展示终态；需要增量事件时遍历 `session.run(...)` 返回的 execution handle，并在结束时等待 `result()`。自定义 Host 必须自行提供其声明的能力和权限边界；LocalAgentHost 不替代操作系统隔离。

下一步：[Agent 不可用或模型缺失](runner-troubleshooting.md)。

图片生成与桌面工具由 Node 提供。独立 SDK/CLI 保留通用工具与自定义 Skill，但不默认提供这两类能力；其他宿主需要自行集成。
