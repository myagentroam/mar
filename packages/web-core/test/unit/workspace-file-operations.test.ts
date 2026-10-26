import { describe, expect, it, vi } from 'vitest';
import type { ScopedHttpService } from '../../src/service/scoped-http-service.js';
import {
  createWorkspaceFileOperationService,
  type WorkspaceFileOperationTarget
} from '../../src/service/workspace-file-operation-service.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const defaultTarget: WorkspaceFileOperationTarget = {
  nodeId: 'node-1',
  workspaceId: 'workspace-1'
};

function createHarness(
  requestHandler: (path: string, init?: RequestInit) => Promise<unknown> = async () => ({}),
  onWritten: (target: WorkspaceFileOperationTarget) => Promise<void> = async () => {}
) {
  const request = vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(requestHandler);
  const http: ScopedHttpService = {
    async request<T>(path: string, init?: RequestInit): Promise<T> {
      return (await request(path, init)) as T;
    }
  };
  const refresh = vi.fn(onWritten);
  const service = createWorkspaceFileOperationService({ http, onWritten: refresh });
  return { service, request, refresh };
}

function requestUrl(path: string): URL {
  return new URL(path, 'http://workspace.test');
}

describe('Workspace file operations service', () => {
  it('passes the file cursor and preserves valid workspace metadata when listing', async () => {
    const page = {
      files: {
        entries: [
          { path: 'src/main.ts', name: 'main.ts', kind: 'FILE', size: 42 },
          { path: 'src/components', name: 'components', kind: 'DIRECTORY', size: null }
        ],
        nextCursor: 'cursor/next'
      },
      workspace: {
        id: 'workspace / one',
        path: '/srv/workspace',
        kind: 'GIT_WORKSPACE',
        gitSummary: { branch: null }
      }
    };
    const { service, request } = createHarness(async () => page);
    const target = { nodeId: 'node id', workspaceId: 'workspace / one' };

    await expect(service.list(target, 'src/feature branch', 'cursor/previous')).resolves.toEqual({
      ...page.files,
      workspace: page.workspace
    });

    const [path, init] = request.mock.calls[0]!;
    const url = requestUrl(path);
    expect(url.pathname).toBe('/api/workspaces/workspace%20%2F%20one/files');
    expect(url.searchParams.get('nodeId')).toBe('node id');
    expect(url.searchParams.get('path')).toBe('src/feature branch');
    expect(url.searchParams.get('limit')).toBe('200');
    expect(url.searchParams.get('cursor')).toBe('cursor/previous');
    expect(init).toBeUndefined();
  });

  it('rejects malformed file pages rather than returning an invalid cursor', async () => {
    const { service } = createHarness(async () => ({
      files: { entries: [], nextCursor: 17 }
    }));

    await expect(service.list(defaultTarget, '.')).rejects.toThrow('NODE_RESPONSE_INVALID');
  });

  it('maps upload preflight statuses to each submitted name in order', async () => {
    const names = ['new.txt', 'existing.txt', 'directory', 'bad/name', 'missing.txt'];
    const { service, request } = createHarness(async () => ({
      uploads: [
        { status: 'READY', path: 'incoming/new.txt' },
        { status: 'EXISTS_FILE', path: 'incoming/existing.txt' },
        { status: 'EXISTS_DIRECTORY', path: 'incoming/directory' },
        { status: 'UNKNOWN', path: 17 }
      ]
    }));

    await expect(service.preflight(defaultTarget, 'incoming', names)).resolves.toEqual([
      { status: 'READY', path: 'incoming/new.txt' },
      { status: 'EXISTS_FILE', path: 'incoming/existing.txt' },
      { status: 'EXISTS_DIRECTORY', path: 'incoming/directory' },
      { status: 'INVALID_NAME', path: null },
      { status: 'INVALID_NAME', path: null }
    ]);

    const [path, init] = request.mock.calls[0]!;
    expect(requestUrl(path).pathname).toBe('/api/workspaces/workspace-1/uploads/preflight');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      nodeId: 'node-1',
      directory: 'incoming',
      files: names.map((name) => ({ name }))
    });
  });

  it('keeps the original mutation target while its HTTP request is pending', async () => {
    const pending = deferred<unknown>();
    const mutableTarget = { nodeId: 'node-before', workspaceId: 'workspace/before' };
    const { service, request, refresh } = createHarness(async () => pending.promise);

    const mutation = service.mutate(mutableTarget, 'MOVE', 'src/old.txt', 'src/new.txt');
    mutableTarget.nodeId = 'node-after';
    mutableTarget.workspaceId = 'workspace/after';
    pending.resolve({ file: { path: 'src/new.txt' } });

    await expect(mutation).resolves.toBe('src/new.txt');

    const [path, init] = request.mock.calls[0]!;
    expect(requestUrl(path).pathname).toBe('/api/workspaces/workspace%2Fbefore/files/mutate');
    expect(JSON.parse(String(init?.body))).toEqual({
      nodeId: 'node-before',
      action: 'MOVE',
      path: 'src/old.txt',
      destination: 'src/new.txt'
    });
    expect(refresh).toHaveBeenCalledExactlyOnceWith({
      nodeId: 'node-before',
      workspaceId: 'workspace/before'
    });
  });

  it('requests a local file manager reveal without refreshing Workspace content', async () => {
    const { service, request, refresh } = createHarness(async () => ({ revealed: true }));

    await service.reveal(defaultTarget, 'folder with space/notes.txt');

    const [path, init] = request.mock.calls[0]!;
    expect(requestUrl(path).pathname).toBe('/api/workspaces/workspace-1/files/reveal');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      nodeId: 'node-1',
      path: 'folder with space/notes.txt'
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('distinguishes a failed mutation from a failed follow-up refresh', async () => {
    const refreshError = new Error('REFRESH_FAILED');
    const successful = createHarness(
      async () => ({ file: { path: 'created.txt' } }),
      async () => {
        throw refreshError;
      }
    );

    await expect(
      successful.service.mutate(defaultTarget, 'CREATE_FILE', 'created.txt')
    ).resolves.toBe('created.txt');
    expect(successful.refresh).toHaveBeenCalledExactlyOnceWith(defaultTarget);

    const mutationError = new Error('MUTATION_FAILED');
    const failed = createHarness(async () => {
      throw mutationError;
    });
    await expect(failed.service.mutate(defaultTarget, 'DELETE', 'created.txt')).rejects.toBe(
      mutationError
    );
    expect(failed.refresh).not.toHaveBeenCalled();
  });
});
