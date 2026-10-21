export const cliMessagesZhCN = {
  splitBaselineUsage: '用法: prepare-server-split-baseline.mts --check | --sql',
  splitBaselineValid:
    '源数据库已通过离线拆分预检。请保持所有写入方停服；输出 SQL 不会执行任何修改。',
  licenseUsage: '用法: license <keygen|fingerprint|issue|inspect|verify> [--参数 值]',
  licenseKeyWritten: '私钥已写入 {destination}，请将上方公钥更新到 Server 发布配置。',
  resetPasswordRequired: '请通过 MAR_RESET_PASSWORD 提供新的管理员密码。',
  resetPasswordCompleted: '管理员密码已重置，下一次登录后必须修改密码。'
} as const;
