import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Public personal settings ownership', () => {
  it('owns all personal sections and leaves identity and organization extensions to the host', () => {
    const source = readFileSync('src/view/settings/SettingsContent.vue', 'utf8');
    expect(source).toContain('<slot name="account-identity"');
    expect(source).toContain('<slot name="registration-owner"');
    expect(source).not.toMatch(
      /oauth-bindings|\/api\/organizations|EnterpriseManagement|ORGANIZATION/
    );
    for (const section of [
      'account',
      'appearance',
      'shortcuts',
      'about',
      'quick-prompts',
      'personal-instructions'
    ])
      expect(source).toContain(`section === '${section}'`);
  });

  it('keeps personal prompt storage on the authenticated Server API without browser persistence', () => {
    for (const [name, api] of [
      ['QuickPromptSettings', '/api/quick-prompts'],
      ['PersonalInstructionsSettings', '/api/personal-instructions']
    ]) {
      const source = readFileSync(`src/view/settings/${name}.vue`, 'utf8');
      expect(source).toContain(api);
      expect(source).not.toMatch(/localStorage|sessionStorage|EnterpriseManagement/);
    }
  });
});
