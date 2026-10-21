import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { commonMessages } from '../../src/i18n/messages.js';

const components = [
  'skill/SkillCenterPage',
  'skill/McpCenterPanel',
  'skill/SkillDetailsDialog',
  'skill/McpDetailsDialog',
  'settings/ManagementPagination'
];

describe('public Skill and MCP configuration', () => {
  it('keeps catalog display and installation independent of organization policy', () => {
    for (const component of components) {
      const source = readFileSync(
        new URL(`../../src/view/${component}.vue`, import.meta.url),
        'utf8'
      );
      expect(source).not.toMatch(/@\/|ORGANIZATION|ENTERPRISE|\/api\/organizations/u);
    }
    const service = readFileSync(
      new URL('../../src/service/SkillCenterService.ts', import.meta.url),
      'utf8'
    );
    expect(service).not.toMatch(/organizationId|ORGANIZATION|ENTERPRISE|\/api\/organizations/u);
  });

  it.each(['en-US', 'zh-CN'] as const)('owns fixed configuration messages in %s', (locale) => {
    for (const component of components) {
      const source = readFileSync(
        new URL(`../../src/view/${component}.vue`, import.meta.url),
        'utf8'
      );
      for (const match of source.matchAll(/translate\(\s*['"]([^'"]+)['"]/gu)) {
        let value: unknown = commonMessages[locale];
        for (const part of match[1]!.split('.')) {
          value =
            typeof value === 'object' && value !== null
              ? (value as Record<string, unknown>)[part]
              : undefined;
        }
        expect(value, `${component}: ${match[1]}`).toBeTypeOf('string');
      }
    }
  });
});
