import { describe, expect, it, vi } from 'vitest';
import { createEnvironmentSecretService } from '../../ee/web/src/service/environment-secret-service.js';

describe('Web EnvironmentSecretService', () => {
  it('Organization secret creation submits organization identity and public visibility', async () => {
    const requestMock = vi.fn(async () => ({}));
    const service = createEnvironmentSecretService(requestMock as never);
    await service.create({
      scope: 'ORGANIZATION',
      organizationId: 2,
      visibility: 'PUBLIC',
      name: 'SHARED_KEY',
      value: 'secret'
    });
    expect(requestMock).toHaveBeenCalledWith('/api/environment-secrets', {
      method: 'POST',
      body: JSON.stringify({
        scope: 'ORGANIZATION',
        organizationId: 2,
        visibility: 'PUBLIC',
        name: 'SHARED_KEY',
        value: 'secret'
      })
    });
  });
});
