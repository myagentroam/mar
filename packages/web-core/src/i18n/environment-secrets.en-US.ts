export const environmentSecretsEnUS = {
  generated: {
    secretManagementPage: {
      secretManagement: 'Environment Secret Management',
      managePersonalSecrets:
        'Manage sensitive information required by Agents and terminals. It is injected through environment variables when new Agent runs and terminals start. Manage Node environment secrets in Node details and Workspace environment secrets in Workspace details.'
    },
    environmentSecretService: {
      enterAnEnvironmentVariableName: 'Enter an environment variable name',
      theEnvironmentVariableNameCannotExceed128:
        'The environment variable name cannot exceed 128 characters',
      theEnvironmentVariableNameMustStartWith:
        'The environment variable name must start with a letter or underscore',
      theEnvironmentVariableNameCanContainOnly:
        'The environment variable name can contain only letters, numbers, and underscores',
      enterASecretValue: 'Enter a secret value',
      theSecretValueCannotContainNullCharacters: 'The secret value cannot contain null characters',
      theSecretValueCannotExceed16KiB: 'The secret value cannot exceed 16 KiB'
    },
    environmentSecretManager: {
      scope2: 'Scope',
      selectAScope: 'Select a scope',
      deleteEnvironmentSecretNewConversationRunsAnd:
        'Delete environment secret “{value0}”? New Agent runs and terminals will no longer receive this environment variable. Processes that have already started are not affected.',
      deleteSecret: 'Delete Environment Secret',
      deleteSecret2: 'Delete',
      cancel: 'Cancel',
      environmentSecrets: 'Environment Secrets',
      secretName: 'Environment Variable Name:',
      enterASecretName: 'Search names',
      refresh: 'Refresh',
      addSecret: 'Add Environment Secret',
      environmentSecretList: 'Environment secret list',
      name: 'Environment Variable Name',
      value: 'Secret Value',
      scope: 'Scope',
      personal: 'Personal',
      node: 'Node',
      workspace: 'Workspace',
      owner: 'Owner',
      personal2: 'Personal',
      visibility: 'Visibility',
      actions: 'Actions',
      updateValue: 'Update',
      delete: 'Delete',
      addSecret2: 'Add Environment Secret',
      updateSecretValue: 'Update Secret Value',
      environmentVariableName: 'Environment Variable Name',
      enterAnEnvironmentVariableName: 'Enter an environment variable name',
      secretValue: 'Secret Value',
      enterASecretValue: 'Enter a secret value',
      cancel2: 'Cancel',
      save: 'Save'
    }
  }
} as const;
