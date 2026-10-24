import { describe, expect, it, vi } from 'vitest';
import { createCommonManagementPages } from '../../src/service/common-management-pages.js';
import { createManagementComposition } from '../../src/service/management-composition.js';
import { commonMessages } from '../../src/i18n/messages.js';
const admin = {
  authenticated: true,
  mustChangePassword: false,
  isAdmin: true,
  managementWritable: true
};
describe('Common management catalog', () => {
  it('loads every public page without enterprise imports', async () => {
    for (const page of createCommonManagementPages()) {
      const component = page.component as { __asyncLoader: () => Promise<unknown> };
      expect(await component.__asyncLoader(), page.id).toBeTruthy();
    }
  });
  it('owns the complete personal catalog in stable navigation order', () => {
    const pages = createCommonManagementPages();
    expect(
      createManagementComposition(pages)
        .items(admin)
        .map((page) => page.id)
    ).toEqual([
      'resource-nodes',
      'resource-workspaces',
      'skill-config',
      'skill-sources',
      'mcp-sources',
      'secrets',
      'mar-agent-models',
      'conversation-templates',
      'configuration',
      'system'
    ]);
    for (const page of pages)
      for (const locale of ['en-US', 'zh-CN'] as const) {
        let value: unknown = commonMessages[locale];
        for (const part of page.labelKey.split('.'))
          value = (value as Record<string, unknown>)?.[part];
        expect(value, page.labelKey).toBeTypeOf('string');
      }
  });
  it('provides read-only defaults and no enterprise props or eager requests', () => {
    const request = vi.fn();
    for (const page of createCommonManagementPages()) {
      const props = page.props({
        admin: { ...admin, managementWritable: false },
        request,
        nodes: [],
        onlineNodeCount: 0,
        serverVersion: undefined
      });
      expect(props.request).toBe(request);
      expect(props).not.toHaveProperty('role');
      expect(props).not.toHaveProperty('edition');
      expect(props).not.toHaveProperty('organizationId');
      if ('writable' in props) expect(props.writable).toBe(false);
    }
    expect(request).not.toHaveBeenCalled();
  });
});
