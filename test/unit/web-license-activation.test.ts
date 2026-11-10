import { describe, expect, it, vi } from 'vitest';
import License from '../../ee/web/src/view/settings/LicenseManagementPage.vue?unit-render';
import {
  flushComponent,
  renderComponent
} from '../../packages/web-core/test/unit/support/component-renderer.js';

const status = {
  edition: 'COMMUNITY',
  state: 'COMMUNITY',
  reason: null,
  licenseId: null,
  enterpriseName: null,
  expiresAt: null,
  managementWritable: true
};

describe('License activation availability', () => {
  it('does not request or show activation controls for the local community deployment', async () => {
    const request = vi.fn(async (path: string) =>
      path === '/api/license'
        ? { ...status, activationAvailable: false }
        : { requestCode: 'UNEXPECTED-CODE' }
    );
    const view = renderComponent(License, { request });
    try {
      await flushComponent();
      expect(request).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledWith('/api/license');
      expect(view.findAll('ElInput')).toHaveLength(0);
      expect(view.findAll('ElButton')).toHaveLength(0);
    } finally {
      view.unmount();
    }
  });

  it('requests the code and shows activation controls for formal deployments', async () => {
    const request = vi.fn(async (path: string) =>
      path === '/api/license'
        ? { ...status, activationAvailable: true }
        : { requestCode: 'TEST-CODE' }
    );
    const view = renderComponent(License, { request });
    try {
      await flushComponent();
      expect(request).toHaveBeenCalledWith('/api/license/request-code');
      expect(view.findAll('ElInput')).toHaveLength(2);
      expect(view.findAll('ElButton')).toHaveLength(2);
    } finally {
      view.unmount();
    }
  });
});
