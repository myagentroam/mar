---
title: 状态、提示与常见错误
lastUpdated: 2026-10-11
---

# 状态、提示与常见错误

| 显示/错误                                  | 含义                                                            | 用户操作                                                                      |
| ------------------------------------------ | --------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 在线                                       | Node 最近心跳和连接正常                                         | 可选择 Workspace                                                              |
| 离线                                       | Server 当前未连接 Node                                          | 查 Node 服务和出站网络                                                        |
| Working                                    | 当前任务正在启动、运行或停止                                    | 等待、查看工具卡或停止                                                        |
| Idle                                       | 当前会话没有正在执行的任务                                      | 可发送下一条消息                                                              |
| `EXTERNAL_SESSION_ACTIVE`                  | 外部 Agent 仍在运行，Node 不能安全继续该会话                    | 等待外部任务结束后再发送；不要重复提交                                        |
| `SESSION_ACTIVATION_REQUIRED`              | 非标准直连请求绕过了首条消息的原子激活路径                      | 通过会话消息入口发送，不能直接启动外部会话的 Run                              |
| `SESSION_INVALID`                          | 会话保存的模型配置已不再可用                                    | 刷新会话，重新选择当前模型后重试                                              |
| `RUNNER_CAPABILITY_UNSUPPORTED`            | 当前 Agent 不支持该操作                                         | 选择页面实际提供的操作或更新 Agent                                            |
| `CAPABILITY_VERSION_UNSUPPORTED`           | Node 版本不支持请求能力                                         | 升级对应 Node 与 Server/Web                                                   |
| `CONVERSATION_HOSTING_STORAGE_FULL`        | 托管目录所在文件系统使用率已达到 95%，Node 实时拒绝新建托管对话 | 联系管理员在节点详情预览并清理非活跃对话，或先扩容/释放磁盘；已有对话仍可使用 |
| `CONVERSATION_HOSTING_DISABLE_ACTIVE_RUNS` | Node 仍有活动或启动中的托管 Run，不能安全禁用托管能力           | 等待 Run 结束，或由该对话的用户主动停止后再禁用；禁用不会自动取消 Run         |
| `NODE_UPGRADE_PENDING`                     | Node 正等待活动 Run 结束并升级                                  | 等待升级完成，或在节点管理取消升级                                            |
| `NODE_UPGRADE_PACKAGE_UNAVAILABLE`         | 无法确认不超过当前 Server 版本的稳定 npm 包                     | 检查 Server 版本、Registry 配置、网络与发布状态后刷新                         |

排查时保留界面显示的错误码、Server 请求 ID、Node 请求 ID（如有）、发生时间与时区和脱敏详情，按[快速诊断](../troubleshooting/quick-diagnosis.md)关联日志。不要复制密钥、完整内部堆栈或敏感正文。
