import { ref } from 'vue';

export type SystemSettingsSnapshot = Readonly<Record<string, number | boolean | string>>;
export type SystemSettingDefinition = {
  readonly key: string;
  readonly field: string;
  readonly payloadField: string;
  readonly nameKey: string;
  readonly descriptionKey: string;
} & (
  | { readonly type: 'boolean'; readonly initialValue: boolean }
  | { readonly type: 'origin'; readonly initialValue: string; readonly placeholderKey: string }
  | { readonly type: 'json'; readonly initialValue: string; readonly placeholderKey: string }
  | {
      readonly type: 'number';
      readonly initialValue: number;
      readonly min: number;
      readonly max: number;
      readonly placeholderKey?: string;
    }
);

const skillTlsSetting: SystemSettingDefinition = {
  key: 'skill-tls',
  field: 'skillTlsVerificationDisabled',
  payloadField: 'verificationDisabled',
  nameKey: 'generated.systemConfigurationPage.disableSkillSourceTLSVerification',
  descriptionKey: 'generated.systemConfigurationPage.keepThisOffByDefaultUseIt',
  type: 'boolean',
  initialValue: false
};

const htmlPreviewOriginSetting: SystemSettingDefinition = {
  key: 'html-preview-origin',
  field: 'htmlPreviewOrigin',
  payloadField: 'origin',
  nameKey: 'generated.systemConfigurationPage.htmlPreviewOrigin',
  descriptionKey: 'generated.systemConfigurationPage.htmlPreviewOriginDescription',
  placeholderKey: 'generated.systemConfigurationPage.htmlPreviewOriginPlaceholder',
  type: 'origin',
  initialValue: ''
};
const smtpSetting: SystemSettingDefinition = {
  key: 'mail-smtp',
  field: 'smtpConfiguration',
  payloadField: 'config',
  nameKey: 'generated.systemConfigurationPage.smtp',
  descriptionKey: 'generated.systemConfigurationPage.smtpDescription',
  placeholderKey: 'generated.systemConfigurationPage.smtpPlaceholder',
  type: 'json',
  initialValue: '{}'
};
const webPushSetting: SystemSettingDefinition = {
  key: 'web-push',
  field: 'webPushEnabled',
  payloadField: 'enabled',
  nameKey: 'workbenchNotificationCenter.webPushConfiguration.title',
  descriptionKey: 'workbenchNotificationCenter.webPushConfiguration.description',
  type: 'boolean',
  initialValue: false
};

export function createSystemConfigurationService(
  request: <T>(path: string, init?: RequestInit) => Promise<T>,
  extensions: readonly SystemSettingDefinition[] = []
) {
  const settings = [
    ...extensions,
    {
      key: 'mar-agent-resource-input',
      field: 'useResourceUrl',
      payloadField: 'useResourceUrl',
      nameKey: 'marAgentModels.useResourceUrl',
      descriptionKey: 'marAgentModels.globalResourceUrlDescription',
      type: 'boolean' as const,
      initialValue: true
    },
    smtpSetting,
    webPushSetting,
    htmlPreviewOriginSetting,
    skillTlsSetting
  ];
  const byKey = new Map(settings.map((setting) => [setting.key, setting]));
  if (byKey.size !== settings.length) throw new Error('WEB_SYSTEM_SETTING_DUPLICATE');
  const snapshot = ref<SystemSettingsSnapshot>(
    Object.fromEntries(settings.map((setting) => [setting.field, setting.initialValue]))
  );
  const drafts = ref({ ...snapshot.value });
  const editingKey = ref<string | null>(null);
  const savingKey = ref<string | null>(null);
  const loading = ref(false);

  function applySnapshot(value: SystemSettingsSnapshot): void {
    snapshot.value = value;
    drafts.value = { ...value };
  }

  async function load(): Promise<void> {
    if (loading.value || savingKey.value !== null) return;
    loading.value = true;
    try {
      applySnapshot(await request<SystemSettingsSnapshot>('/api/system-settings'));
      editingKey.value = null;
    } finally {
      loading.value = false;
    }
  }

  function beginEdit(key: string): void {
    if (!byKey.has(key) || loading.value || savingKey.value !== null || editingKey.value !== null)
      return;
    drafts.value = { ...snapshot.value };
    editingKey.value = key;
  }

  function cancelEdit(key: string): void {
    if (editingKey.value !== key || savingKey.value !== null) return;
    drafts.value = { ...snapshot.value };
    editingKey.value = null;
  }

  function validValue(
    setting: SystemSettingDefinition,
    value: unknown
  ): value is number | boolean | string {
    if (setting.type === 'json') {
      if (typeof value !== 'string' || value.length > 4096) return false;
      try {
        const parsed: unknown = JSON.parse(value);
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
      } catch {
        return false;
      }
    }
    if (setting.type === 'origin') {
      if (value === '') return true;
      if (typeof value !== 'string' || value.length > 253) return false;
      try {
        const url = new URL(value);
        return (
          url.origin === value &&
          (url.protocol === 'https:' ||
            (url.protocol === 'http:' &&
              ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
        );
      } catch {
        return false;
      }
    }
    return setting.type === 'boolean'
      ? typeof value === 'boolean'
      : typeof value === 'number' &&
          Number.isFinite(value) &&
          value >= setting.min &&
          value <= setting.max;
  }

  function setDraft(key: string, value: unknown): void {
    const setting = byKey.get(key);
    if (
      setting === undefined ||
      editingKey.value !== key ||
      savingKey.value !== null ||
      !(setting.type === 'origin' || setting.type === 'json'
        ? typeof value === 'string' && value.length <= (setting.type === 'json' ? 4096 : 253)
        : validValue(setting, value))
    )
      return;
    drafts.value[setting.field] = value as number | boolean | string;
  }

  async function save(key: string): Promise<boolean> {
    const setting = byKey.get(key);
    if (
      setting === undefined ||
      editingKey.value !== key ||
      savingKey.value !== null ||
      loading.value
    )
      return false;
    const value = drafts.value[setting.field];
    if (!validValue(setting, value)) return false;
    savingKey.value = key;
    try {
      applySnapshot(
        await request<SystemSettingsSnapshot>(`/api/system-settings/${encodeURIComponent(key)}`, {
          method: 'PATCH',
          body: JSON.stringify({ [setting.payloadField]: value })
        })
      );
      editingKey.value = null;
      return true;
    } finally {
      savingKey.value = null;
    }
  }

  return {
    settings,
    snapshot,
    drafts,
    editingKey,
    savingKey,
    loading,
    load,
    beginEdit,
    cancelEdit,
    validValue,
    setDraft,
    save
  };
}
