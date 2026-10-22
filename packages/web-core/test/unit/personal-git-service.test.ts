import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { PersonalGitService } from '../../src/service/PersonalGitService.js';

describe('Personal Git settings client', () => {
  it('preserves an explicit disabled parent repository policy without defaulting legacy responses', async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ preserveGitConfig: true, includeParentRepository: false });
    const service = new PersonalGitService(request);
    expect(await service.workspacePolicy('node', 'child')).toEqual({
      preserveGitConfig: true,
      includeParentRepository: false
    });
    await service.saveWorkspacePolicy('node', 'child', true, false);
    expect(JSON.parse(request.mock.calls[1]![1].body)).toEqual({
      preserveGitConfig: true,
      includeParentRepository: false
    });
    request.mockResolvedValue({ preserveGitConfig: true });
    expect(
      (await service.workspacePolicy('old-node', 'child')).includeParentRepository
    ).toBeUndefined();
  });
  it('uses no-store requests for workspace policies without an app-version gate', async () => {
    const request = vi.fn().mockResolvedValue({ preserveGitConfig: true });
    const service = new PersonalGitService(request);
    await service.workspacePolicy('node', 'workspace/id');
    await service.saveWorkspacePolicy('node', 'workspace/id', false);
    expect(request.mock.calls).toEqual([
      ['/api/workspaces/workspace%2Fid/git-policy?nodeId=node', { cache: 'no-store' }],
      [
        '/api/workspaces/workspace%2Fid/git-policy?nodeId=node',
        { method: 'PUT', cache: 'no-store', body: '{"preserveGitConfig":false}' }
      ]
    ]);
  });

  it('rejects a server response that accidentally returns credential secrets', async () => {
    const request = vi.fn().mockResolvedValue({
      configuration: {
        credentials: [
          {
            id: 'id',
            name: 'test',
            protocol: 'HTTPS',
            host: 'example.com',
            port: 443,
            pathPrefix: '',
            username: 'alice',
            commitName: 'Alice',
            commitEmail: 'alice@example.test',
            hasSecret: true,
            hasPassphrase: false,
            secret: 'unexpected'
          }
        ]
      }
    });
    await expect(new PersonalGitService(request).read()).rejects.toThrow(
      'GIT_CONFIGURATION_INVALID'
    );
  });
  it('unwraps redacted read responses', async () => {
    const configuration = {
      credentials: []
    };
    const request = vi.fn().mockResolvedValue({ configuration });
    const service = new PersonalGitService(request);
    expect(await service.read()).toEqual(configuration);
  });

  it('renders the complete redacted Git configuration without local pagination', () => {
    const source = readFileSync(
      new URL('../../src/view/settings/PersonalGitSettings.vue', import.meta.url),
      'utf8'
    );
    expect(source).toContain(':data="summary.credentials"');
    expect(source).not.toContain('managementPageItems');
    expect(source).not.toContain('<ManagementPagination');
  });
});
