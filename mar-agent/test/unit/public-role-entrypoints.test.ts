import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const execute = promisify(execFile);
const require = createRequire(import.meta.url);

// The caller must build the package first; this test never changes the shared dist directory.
it('supports external NodeNext consumers through role entries without exposing implementation paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mar-role-types-'));
  try {
    const modules = join(root, 'node_modules', '@myagentroam');
    await mkdir(modules, { recursive: true });
    await symlink(resolve('.'), join(modules, 'agent'), 'junction');
    await writeFile(
      join(root, 'consumer.mts'),
      `import { AgentError, type RunInput, type AgentModelTransportTestResult } from '@myagentroam/agent';
import { negotiateHost, type HostDescription, type ExtensionFilesBackend as HostFilesBackend } from '@myagentroam/agent/host';
import type { AgentExtension, ExtensionCheckpoint as ExtensionCheckpointView, ExtensionFilesBackend } from '@myagentroam/agent/extensions';
import type { ExtensionCheckpoint, ExtensionJsonValue, SessionStore } from '@myagentroam/agent/session-store';
import { requestHttp, type HttpAttempt, type HttpRequestInit } from '@myagentroam/agent/host/network';
import { LINUX_BUBBLEWRAP_SANDBOX_POLICY_VERSION, type BubblewrapSandboxProfile } from '@myagentroam/agent/sandbox/linux';

const input: RunInput = { prompt: 'Continue' };
const result: AgentModelTransportTestResult = { completed: true, response: 'OK' };
const extension: AgentExtension = { id: 'example', apiVersion: '1.0' };
const value: ExtensionJsonValue = { progress: ['verified', 1] };
const checkpoint: ExtensionCheckpoint = { revision: 1, value };
const extensionCheckpoint: ExtensionCheckpointView = checkpoint;
const storedCheckpoint: ExtensionCheckpoint = extensionCheckpoint;
declare const files: ExtensionFilesBackend;
const hostFiles: HostFilesBackend = files;
const extensionFiles: ExtensionFilesBackend = hostFiles;
declare const store: SessionStore;
const tree: Promise<readonly string[]> = store.sessionTree('session');
const description: HostDescription = {
  apiVersion: '1.0', mode: 'normal', homeDirectory: '/tmp/agent', platform: 'linux',
  capabilities: ['workspace.read', 'workspace.patch', 'process.manage', 'user-input.request', 'event.publish'],
  limits: { maxProcesses: 1, maxOutputBytes: 1024, maxExecutionMs: 1000 }
};
const attempt: HttpAttempt = { request: { method: 'GET' }, httpVersion: '1.1' };
const init: HttpRequestInit = attempt;
const profile: BubblewrapSandboxProfile = { policyVersion: LINUX_BUBBLEWRAP_SANDBOX_POLICY_VERSION, networkMode: 'NONE' };
void [input, result, extension, storedCheckpoint, extensionFiles, tree, profile, new AgentError('EXAMPLE', 'Example')];
void negotiateHost(description);
void requestHttp('https://example.invalid', init, new AbortController().signal, 1000);

// @ts-expect-error Internal implementation modules are not package entries.
import type { ModelRequest } from '@myagentroam/agent/agent-core/model/contracts.js';
// @ts-expect-error Flattened model implementation modules are not package entries.
import type { ModelRequest as InternalModelRequest } from '@myagentroam/agent/model/contracts.js';
// @ts-expect-error Flattened SDK implementation modules are not package entries.
import type { SessionRuntime } from '@myagentroam/agent/sdk/session-runtime.js';
// @ts-expect-error Old root names are not compatibility aliases.
import { MarAgentError } from '@myagentroam/agent';
// @ts-expect-error Old Extension names are not compatibility aliases.
import type { CoreRuntimeExtension } from '@myagentroam/agent/extensions';
// @ts-expect-error Old Host names are not compatibility aliases.
import type { MarAgentHost } from '@myagentroam/agent/host';
// @ts-expect-error Old Store DTO names are not compatibility aliases.
import type { CoreCheckpoint } from '@myagentroam/agent/session-store';
// @ts-expect-error Old network DTO names are not compatibility aliases.
import type { ModelHttpAttempt } from '@myagentroam/agent/host/network';
`
    );
    await writeFile(
      join(root, 'runtime.mjs'),
      `import assert from 'node:assert/strict';
import * as agent from '@myagentroam/agent';
import * as host from '@myagentroam/agent/host';
import * as extensions from '@myagentroam/agent/extensions';
import * as store from '@myagentroam/agent/session-store';
import * as network from '@myagentroam/agent/host/network';
import * as sandbox from '@myagentroam/agent/sandbox/linux';
assert.equal(typeof agent.AgentError, 'function');
assert.equal(typeof agent.testAgentModelTransport, 'function');
assert.equal(typeof host.negotiateHost, 'function');
assert.equal(typeof network.requestHttp, 'function');
assert.equal(typeof sandbox.LINUX_BUBBLEWRAP_SANDBOX_POLICY_VERSION, 'number');
assert.equal('CoreRuntimeExtension' in extensions, false);
assert.equal('CoreCheckpoint' in store, false);
assert.equal('MarAgentError' in agent, false);
assert.equal('testMarAgentModelTransport' in agent, false);
await assert.rejects(import('@myagentroam/agent/agent-core/model/contracts.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
await assert.rejects(import('@myagentroam/agent/model/contracts.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
await assert.rejects(import('@myagentroam/agent/sdk/session-runtime.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
`
    );
    const nodeTypes = dirname(dirname(require.resolve('@types/node/package.json')));
    await execute(process.execPath, [
      require.resolve('typescript/bin/tsc'),
      '--noEmit',
      '--strict',
      '--exactOptionalPropertyTypes',
      '--noUncheckedIndexedAccess',
      '--target',
      'ES2024',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--typeRoots',
      nodeTypes,
      join(root, 'consumer.mts')
    ]).catch((error) => {
      throw new Error(`Public role consumer failed to compile:\n${error.stdout}${error.stderr}`, {
        cause: error
      });
    });
    const runtime = await execute(process.execPath, [join(root, 'runtime.mjs')]);
    expect(runtime.stderr).toBe('');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
