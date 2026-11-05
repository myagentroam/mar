import { ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { createWorkspaceRegistrationService } from '../../src/service/workspace-registration-service.js';

function setup() {
  const request = vi.fn(async () => ({ workspace: { id: 'workspace-new' } })) as unknown as <T>(
    path: string,
    init?: RequestInit
  ) => Promise<T>;
  const error = vi.fn();
  const onRegistered = vi.fn(async () => undefined);
  const service = createWorkspaceRegistrationService({
    targetNodeId: ref<string | undefined>('node-a'),

    request,
    onRegistered,
    notice: vi.fn(),
    error,
    errorMessage: String
  });
  return { service, request, error, onRegistered };
}

describe('public workspace registration', () => {
  it('owns its pending state until the registration completes', async () => {
    let finish!: (value: unknown) => void;
    const service = createWorkspaceRegistrationService({
      targetNodeId: ref<string | undefined>('node-a'),
      request: <T>() =>
        new Promise<T>((resolve) => {
          finish = resolve as (value: unknown) => void;
        }),
      onRegistered: vi.fn(),
      notice: vi.fn(),
      error: vi.fn(),
      errorMessage: String
    });
    service.path.value = '/project';
    const pending = service.register();
    expect(service.loading.value).toBe(true);
    finish({ workspace: { id: 'workspace-new' } });
    await pending;
    expect(service.loading.value).toBe(false);
  });

  it('refreshes a Windows drive root without dropping its separator or directory entries', async () => {
    const directory = {
      homePath: 'C:\\Users\\node',
      currentPath: 'E:\\',
      parentPath: null,
      browseRoots: ['E:\\'],
      selectable: true,
      entries: [{ name: 'Projects', path: 'E:\\Projects', selectable: true }],
      truncated: false
    };
    const request = vi.fn(async (_path: string) => ({ directory }));
    const service = createWorkspaceRegistrationService({
      targetNodeId: ref<string | undefined>('node-a'),

      request: async <T>(path: string) => (await request(path)) as T,
      onRegistered: vi.fn(),
      notice: vi.fn(),
      error: vi.fn(),
      errorMessage: String
    });
    await service.load('E:\\');
    const query = new URL(request.mock.calls[0]![0], 'http://localhost').searchParams;
    expect(query.get('path')).toBe('E:\\');
    expect(query.get('nodeId')).toBe('node-a');
    expect(service.directory.value).toEqual(directory);
    expect(service.loadingDirectory.value).toBe(false);
    service.select('E:\\Projects');
    expect(service.selectedPathValid.value).toBe(true);
  });

  it('submits the selected Git policy for baseline Nodes and resets the draft', async () => {
    const { service, request, onRegistered } = setup();
    expect(service.preserveGitConfig.value).toBe(false);
    service.path.value = '/project';
    service.preserveGitConfig.value = true;
    await service.register();
    expect(request).toHaveBeenCalledWith('/api/workspaces', {
      method: 'POST',
      body: JSON.stringify({
        nodeId: 'node-a',
        path: '/project',
        preserveGitConfig: true
      })
    });
    expect(service.preserveGitConfig.value).toBe(false);
    expect(onRegistered).toHaveBeenCalledWith('node-a', 'workspace-new');
  });
  it('keeps the selected path and releases loading when submission fails', async () => {
    const error = vi.fn();
    const failure = new Error('FAILED');
    const service = createWorkspaceRegistrationService({
      targetNodeId: ref<string | undefined>('node-a'),

      request: async () => {
        throw failure;
      },
      onRegistered: vi.fn(),
      notice: vi.fn(),
      error,
      errorMessage: String
    });
    service.path.value = '/project';
    await service.register();
    expect(service.path.value).toBe('/project');
    expect(service.loading.value).toBe(false);
    expect(error).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(expect.any(String), failure);
  });

  it('ignores directory and registration responses after selection changes to another Node', async () => {
    let resolve!: (value: unknown) => void;
    const selectedNodeId = ref<string | undefined>('node-a');
    const onRegistered = vi.fn();
    const service = createWorkspaceRegistrationService({
      targetNodeId: selectedNodeId,

      request: <T>() =>
        new Promise<T>((done) => {
          resolve = done as (value: unknown) => void;
        }),
      onRegistered,
      notice: vi.fn(),
      error: vi.fn(),
      errorMessage: String
    });
    const pending = service.load();
    selectedNodeId.value = 'node-b';
    resolve({ directory: { currentPath: '/stale' } });
    await pending;
    expect(service.directory.value).toBeUndefined();
    expect(service.loadingDirectory.value).toBe(false);

    selectedNodeId.value = 'node-a';
    service.path.value = '/project';
    const registration = service.register();
    selectedNodeId.value = 'node-b';
    resolve({ workspace: { id: 'workspace-new' } });
    await registration;
    expect(onRegistered).not.toHaveBeenCalled();
    expect(service.path.value).toBe('/project');
  });

  it('submits ordinary registration without ownership fields', async () => {
    const { service, request } = setup();
    service.path.value = ' /project ';
    await service.register();
    expect(request).toHaveBeenCalledWith('/api/workspaces', {
      method: 'POST',
      body: JSON.stringify({ nodeId: 'node-a', path: '/project', preserveGitConfig: false })
    });
    expect(service.path.value).toBe('');
  });

  it('converts a Windows pending directory into parent and single name', async () => {
    const { service, request } = setup();
    service.directory.value = {
      homePath: 'C:\\work',
      currentPath: 'C:\\work',
      parentPath: 'C:\\',
      browseRoots: ['C:\\'],
      selectable: true,
      entries: [],
      truncated: false
    };
    service.selectPendingDirectory('project');
    expect(service.path.value).toBe('C:\\work\\project');
    expect(service.selectedPathValid.value).toBe(true);
    await service.register();
    expect(request).toHaveBeenCalledWith('/api/workspaces', {
      method: 'POST',
      body: JSON.stringify({
        nodeId: 'node-a',
        path: 'C:\\work',
        preserveGitConfig: false,
        createDirectoryName: 'project'
      })
    });
  });

  it('passes opaque context only to the host submission callback', async () => {
    const submit = vi.fn(async () => ({ workspace: { id: 'enterprise-workspace' } }));
    const request = vi.fn();
    const onRegistered = vi.fn(async () => undefined);
    const service = createWorkspaceRegistrationService<{ scopeId: number }>({
      targetNodeId: ref<string | undefined>('node-a'),

      request,
      submit,
      onRegistered,
      notice: vi.fn(),
      error: vi.fn(),
      errorMessage: String
    });
    service.path.value = '/project';
    await service.register({ scopeId: 7 });
    expect(submit).toHaveBeenCalledWith(
      { nodeId: 'node-a', path: '/project', preserveGitConfig: false },
      { scopeId: 7 }
    );
    expect(request).not.toHaveBeenCalled();
    expect(service.loading.value).toBe(false);
    expect(onRegistered).toHaveBeenCalledWith('node-a', 'enterprise-workspace');
  });
});
