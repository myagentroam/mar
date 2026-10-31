export const authenticationZhCN = {
  common: { productName: 'MyAgentRoam' },
  auth: {
    title: '继续你的 Agent 工作。',
    summary: '登录后查看已验证的节点、工作区与会话。',
    username: '账户',
    password: '密码',
    login: '进入控制台',
    unavailableTitle: '无法确认登录状态',
    unavailableSummary:
      '暂时无法连接服务器确认登录状态。请恢复网络后重试或打开帮助；工作区和账户数据需要联网。',
    retry: '重试连接',
    help: '打开帮助文档'
  },
  passwordGate: {
    firstUse: '首次使用',
    title: '先设置你的控制台密码。',
    summary: '此账号仍使用初始状态，完成改密前不能访问任何节点或会话。',
    requirement: '新密码至少需要 8 个字符。',
    current: '当前密码',
    next: '新密码',
    confirmation: '再次输入新密码',
    submit: '保存并继续'
  },
  generated: {
    adminAuthService: {
      authenticationRecoveryFailed: '无法确认登录状态，请重试：{value0}',
      workbenchRecoveryFailed: '工作台恢复失败：{value0}',
      unableToLoadSignInSessions: '无法读取登录会话：{value0}',
      unableToRevokeTheSignInSession: '无法注销登录会话：{value0}',
      signInFailed: '登录失败：{value0}',
      theNewPasswordMustContainAtLeast: '新密码至少需要 {value0} 个字符。',
      theNewPasswordsDoNotMatch: '两次输入的新密码不一致。',
      passwordUpdatedPreviousSignInSessionsWere: '密码已更新，旧登录状态已撤销。',
      unableToUpdateThePassword: '无法更新密码：{value0}',
      unableToSignOut: '无法退出登录：{value0}'
    }
  }
} as const;
