import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
// The test entry builds once before workers start; tests only consume dist.

it('allows an external strict NodeNext consumer to use execution handles and inject the Store', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mar-store-types-'));
  try {
    const modules = join(root, 'node_modules', '@myagentroam');
    await mkdir(modules, { recursive: true });
    await symlink(resolve('.'), join(modules, 'agent'), 'junction');
    // Compile the actual limited backend against published declarations, not source aliases.
    const source = (await readFile(join('test', 'support', 'text-session-store.ts'), 'utf8'))
      .replace(/['"]\.\.\/\.\.\/src\/index\.js['"]/u, "'@myagentroam/agent'")
      .replace(/['"]\.\.\/\.\.\/src\/session-store\.js['"]/u, "'@myagentroam/agent/session-store'");
    await writeFile(join(root, 'store.mts'), source);
    await writeFile(
      join(root, 'consumer.mts'),
      [
        "import { createAgent, openAgentSessionCatalog, type CreateAgentOptions } from '@myagentroam/agent';",
        "import type { CompactInput, ExecutionHandle, ExecutionResult, AgentEvent, AgentSession, RunInput } from '@myagentroam/agent';",
        "import type { SessionStore, SessionStoreCompactInput, CompactHistoryMessage, ModelMessage, ModelUsage, ModelInputMetadata, ModelTextBlock, ModelContextualBlock, EnvironmentContextState } from '@myagentroam/agent/session-store';",
        "import type { SessionExecutionState, TodoSnapshot, TodoItem, CodeToolCallRecord, CodeObservation } from '@myagentroam/agent/session-store';",
        "import type { SessionInputImageMetadata, SessionInputImageData } from '@myagentroam/agent/session-store';",
        "import type { ContextGcCheckpointDraft, ContextGcBase, ContextGcPlatform, ContextGcEconomicsPolicy, ContextGcMetrics, ContextGcReplacement, ContextGcTarget, ContextGcReadItemReplacement, ContextGcWebToolName, ContextGcSubagentToolName } from '@myagentroam/agent/session-store';",
        '// @ts-expect-error Model adapters are not a public extension point.',
        "import type { ModelAdapter } from '@myagentroam/agent';",
        '// @ts-expect-error Internal implementation paths remain outside package exports.',
        "import type { ModelRequest } from '@myagentroam/agent/agent-core/model/contracts.js';",
        "import { textSessionStore } from './store.mjs';",
        'declare const session: AgentSession;',
        "const compactInput: CompactInput = { prompt: 'Preserve progress', async: true };",
        'const compatibleInput: Partial<RunInput> & { readonly async?: boolean } = compactInput;',
        'const roundTripInput: CompactInput = compatibleInput;',
        "const runInput: RunInput = { prompt: 'Continue the task' };",
        'const partialInput: CompactInput = runInput;',
        'type CompatibleHandle = AsyncIterable<AgentEvent> & { readonly executionId: string; result(): Promise<ExecutionResult>; cancel(): void };',
        'declare const compatibleHandle: CompatibleHandle;',
        'const roundTripHandle: ExecutionHandle = compatibleHandle;',
        'const compactHandle: ExecutionHandle = session.compact(roundTripInput);',
        'const handle: CompatibleHandle = compactHandle;',
        'const runHandle: ExecutionHandle = session.run(runInput);',
        'const planHandle: ExecutionHandle = session.plan(runInput);',
        '// @ts-expect-error Compact async mode remains boolean.',
        "const invalidCompactInput: CompactInput = { async: 'true' };",
        "const todoItem: TodoItem = { id: 'verify', step: 'Verify the Store', status: 'pending' };",
        'const todo: TodoSnapshot = { revision: 1, items: [todoItem] };',
        'const state: SessionExecutionState = { automaticTitlePending: false, todo, contextRecords: [] };',
        "const image: SessionInputImageMetadata = { resourceInputVersion: 1, resourceId: 'resource-id', name: 'image.png', mimeType: 'image/png', byteSize: 1, sha256: 'hash' };",
        "const imageData: SessionInputImageData = { ...image, dataBase64: 'YQ==' };",
        '// @ts-expect-error Logical image metadata requires a resource identity.',
        "const missingResource: SessionInputImageMetadata = { resourceInputVersion: 1, name: 'image.png', mimeType: 'image/png', byteSize: 1, sha256: 'hash' };",
        '// @ts-expect-error Logical image metadata requires its input version.',
        "const missingVersion: SessionInputImageMetadata = { resourceId: 'resource-id', name: 'image.png', mimeType: 'image/png', byteSize: 1, sha256: 'hash' };",
        'void imageData; void missingResource; void missingVersion;',
        'const store: SessionStore = { ...textSessionStore().store, readExecutionState: async () => state };',
        "const metadata: ModelInputMetadata = { source: 'user', recordId: 'input' };",
        "const textBlock: ModelTextBlock = { text: 'Retained input' };",
        "const contextualBlock: ModelContextualBlock = { id: 'environment', kind: 'environment', source: 'sdk', authority: 'context', revision: '1', operation: 'replace' };",
        "const call: CodeToolCallRecord = { callId: 'read', toolName: 'read', input: { path: 'file.ts' }, status: 'completed' };",
        "const observation: CodeObservation = { type: 'value', id: 'value', format: 'text', value: 'Retained evidence' };",
        "const message: ModelMessage = { role: 'user', content: textBlock.text, textBlocks: [textBlock], metadata, contextKind: 'contextual', contextualBlock };",
        "const result: ModelMessage = { role: 'tool', content: 'Retained evidence', callId: 'code', name: 'code_exec', calls: [call], observations: [observation] };",
        'const usage: ModelUsage = { totalInputTokens: 20, inputTokens: 20, outputTokens: 2 };',
        "const environment: EnvironmentContextState = { platform: 'linux', workspace: '/workspace' };",
        "const replacement: CompactHistoryMessage = { role: 'user', kind: 'summary', content: 'Summary', metadata };",
        "const compact: SessionStoreCompactInput = { summary: 'Summary', replacementHistory: [replacement], retainedModelContext: [message, result], environment, usage };",
        "void store.compact('session', compact);",
        'function persistGc(draft: ContextGcCheckpointDraft) {',
        '  const base: ContextGcBase = draft.base;',
        '  const platform: ContextGcPlatform = draft.trigger.platform;',
        '  const economics: ContextGcEconomicsPolicy = { ...draft.economics, version: 1 };',
        '  const metrics: ContextGcMetrics = { ...draft.metrics, reclaimedTokens: 100 };',
        "  const target: ContextGcTarget = { sequence: 1, recordId: 'tool', role: 'tool' };",
        "  const item: ContextGcReadItemReplacement = { index: 0, path: 'file.ts', replacement: 'Superseded', evidenceSequence: 2 };",
        "  const webTool: ContextGcWebToolName = 'web_fetch';",
        "  const subagentTool: ContextGcSubagentToolName = 'agent_wait';",
        '  const replacements: ContextGcReplacement[] = [',
        "    { kind: 'READ_OUTPUT_ITEMS', callId: 'read', target, items: [item], evidenceSequences: [2] },",
        "    { kind: 'WEB_OUTPUT', toolName: webTool, callId: 'web', target, replacementContent: 'Superseded', evidenceSequence: 2 },",
        "    { kind: 'SUBAGENT_OUTPUT', toolName: subagentTool, callId: 'wait', target, replacementContent: 'Superseded', terminalToolName: subagentTool, terminalCallId: 'done', evidenceSequence: 2 }",
        '  ];',
        "  return store.commitContextGc('session', { ...draft, base, trigger: { ...draft.trigger, platform }, economics, metrics, replacements });",
        '}',
        'declare const options: CreateAgentOptions;',
        'void createAgent({ ...options, sessionStore: store });',
        'void openAgentSessionCatalog({ sessionStore: store });',
        "void openAgentSessionCatalog({ homeDirectory: '/tmp/example' });",
        '// @ts-expect-error A Catalog must have exactly one storage source.',
        "void openAgentSessionCatalog({ homeDirectory: '/tmp/example', sessionStore: store });",
        '// @ts-expect-error A Catalog needs a storage source.',
        'void openAgentSessionCatalog({});'
      ].join('\n')
    );
    const nodeTypes = dirname(dirname(require.resolve('@types/node/package.json')));
    const result = await execute(process.execPath, [
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
      '--skipLibCheck',
      '--typeRoots',
      nodeTypes,
      join(root, 'consumer.mts')
    ]).catch((error) => {
      throw new Error(`Public Store consumer failed to compile:\n${error.stdout}${error.stderr}`, {
        cause: error
      });
    });
    expect(result.stderr).toBe('');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
