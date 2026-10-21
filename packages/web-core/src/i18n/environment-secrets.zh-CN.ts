export const environmentSecretsZhCN = {
  generated: {
    secretManagementPage: {
      secretManagement: '环境密钥管理',
      managePersonalSecrets:
        '集中管理 Agent 和终端所需的敏感信息，并在新建 Agent 运行和终端时通过环境变量注入；节点环境密钥请在节点详情中管理，工作区环境密钥请在工作区详情中管理。'
    },
    environmentSecretService: {
      enterAnEnvironmentVariableName: '请输入环境变量名',
      theEnvironmentVariableNameCannotExceed128: '环境变量名不能超过 128 个字符',
      theEnvironmentVariableNameMustStartWith: '环境变量名必须以字母或下划线开头',
      theEnvironmentVariableNameCanContainOnly: '环境变量名只能包含字母、数字和下划线',
      enterASecretValue: '请输入密钥值',
      theSecretValueCannotContainNullCharacters: '密钥值不能包含空字符',
      theSecretValueCannotExceed16KiB: '密钥值不能超过 16 KiB'
    },
    environmentSecretManager: {
      scope2: '范围',
      selectAScope: '请选择范围',
      deleteEnvironmentSecretNewConversationRunsAnd:
        '确定删除环境密钥“{value0}”吗？删除后，新建的 Agent 运行和终端将不再注入该环境变量；已经启动的进程不受影响。',
      deleteSecret: '删除环境密钥',
      deleteSecret2: '删除',
      cancel: '取消',
      environmentSecrets: '环境密钥',
      secretName: '环境变量名：',
      enterASecretName: '搜索环境变量名',
      refresh: '刷新',
      addSecret: '新增环境密钥',
      environmentSecretList: '环境密钥列表',
      name: '环境变量名',
      value: '密钥值',
      scope: '范围',
      personal: '个人',
      node: '节点',
      workspace: '工作区',
      owner: '归属',
      personal2: '个人',
      visibility: '可见性',
      actions: '操作',
      updateValue: '更新',
      delete: '删除',
      addSecret2: '新增环境密钥',
      updateSecretValue: '更新密钥值',
      environmentVariableName: '环境变量名',
      enterAnEnvironmentVariableName: '请输入环境变量名',
      secretValue: '密钥值',
      enterASecretValue: '请输入密钥值',
      cancel2: '取消',
      save: '保存'
    }
  }
} as const;
