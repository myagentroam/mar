import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createEnvironmentSecretService,
  environmentSecretNameError,
  environmentSecretValueError
} from '../../src/service/EnvironmentSecretService.js';
import { i18n, translate } from '../../src/service/LocalePreferenceService.js';

describe('Public environment secret client', () => {
  beforeEach(() => {
    i18n.global.locale.value = 'zh-CN';
  });
  it('validates names and UTF-8 value boundaries', () => {
    expect(environmentSecretNameError('111')).toBe(
      translate('generated.environmentSecretService.theEnvironmentVariableNameMustStartWith')
    );
    expect(environmentSecretNameError('API_KEY')).toBeUndefined();
    expect(environmentSecretNameError(`A${'x'.repeat(128)}`)).toBe(
      translate('generated.environmentSecretService.theEnvironmentVariableNameCannotExceed128')
    );
    expect(environmentSecretNameError('')).toBeDefined();
    expect(environmentSecretNameError('A-B')).toBeDefined();
    expect(environmentSecretValueError('')).toBe(
      translate('generated.environmentSecretService.enterASecretValue')
    );
    expect(environmentSecretValueError('a\0b')).toBe(
      translate('generated.environmentSecretService.theSecretValueCannotContainNullCharacters')
    );
    expect(environmentSecretValueError('value')).toBeUndefined();
    expect(environmentSecretValueError('a'.repeat(16384))).toBeUndefined();
    expect(environmentSecretValueError('\u3042'.repeat(5462))).toBeDefined();
  });

  it('uses the existing CRUD paths without retaining values or querying organizations', async () => {
    const request = vi.fn(async () => ({ secrets: [] }));
    const service = createEnvironmentSecretService(request as never);
    await service.list();
    await service.list('node/a?b');
    await service.create({
      scope: 'NODE',
      nodeId: 'node/a?b',
      name: 'API_KEY',
      value: 'test-fixture'
    });
    await service.replace('id/a?b', 'replacement');
    await service.remove('id/a?b');
    expect(request.mock.calls).toEqual([
      ['/api/environment-secrets'],
      ['/api/environment-secrets?nodeId=node%2Fa%3Fb'],
      [
        '/api/environment-secrets',
        {
          method: 'POST',
          body: JSON.stringify({
            scope: 'NODE',
            nodeId: 'node/a?b',
            name: 'API_KEY',
            value: 'test-fixture'
          })
        }
      ],
      [
        '/api/environment-secrets/id%2Fa%3Fb',
        { method: 'PUT', body: JSON.stringify({ value: 'replacement' }) }
      ],
      ['/api/environment-secrets/id%2Fa%3Fb', { method: 'DELETE' }]
    ]);
    expect(service).not.toHaveProperty('secrets');
  });

  it('propagates the original failure without retrying a secret write', async () => {
    const failure = new Error('FORBIDDEN');
    const request = vi.fn(async () => {
      throw failure;
    });
    const service = createEnvironmentSecretService(request as never);
    await expect(service.replace('id', 'test-fixture')).rejects.toBe(failure);
    expect(request).toHaveBeenCalledOnce();
  });

  it('isolates Workspace requests and submits their owning Node without organization fields', async () => {
    const request = vi.fn(async () => ({ secrets: [] }));
    const service = createEnvironmentSecretService(request as never);
    await service.list('node/a', 'workspace?b');
    const input = {
      scope: 'WORKSPACE' as const,
      nodeId: 'node/a',
      workspaceId: 'workspace?b',
      name: 'PROJECT_TOKEN',
      value: 'workspace-fixture'
    };
    await service.create(input);
    expect(request).toHaveBeenNthCalledWith(
      1,
      '/api/environment-secrets?nodeId=node%2Fa&workspaceId=workspace%3Fb'
    );
    expect(request).toHaveBeenNthCalledWith(2, '/api/environment-secrets', {
      method: 'POST',
      body: JSON.stringify(input)
    });
    expect(service).not.toHaveProperty('secrets');
  });
});
