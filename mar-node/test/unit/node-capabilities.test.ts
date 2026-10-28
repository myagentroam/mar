vi.mock('ws', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ws')>();
  const { mockedWebSocket } = await import('./support/control-socket.js');
  return { ...actual, default: mockedWebSocket(actual.default) };
});
import { connectTestSocket } from './support/control-socket.js';
import { describe, expect, it, vi } from 'vitest';
import type { NodeCapabilities } from '../../../packages/protocol/src/index.js';
import {
  detectCapabilities,
  reportedPlatform,
  unavailableCapabilities
} from '../../src/capabilities.js';
import { NodeConnector } from '../../src/connector.js';
import { detectRuntimeCommands, normalizeVersion } from '../../src/runtime-command-detector.js';

describe('Node capability version reporting', () => {
  it('declares MAR Agent dynamic credential transport in every capability snapshot', () => {
    for (const capabilities of [unavailableCapabilities(), detectCapabilities()]) {
      expect(capabilities.marAgentRuntimeCredentials).toEqual({
        apiVersion: 1,
        websocket: true,
        httpVersions: ['1.1', '2'],
        fastMode: true,
        namespacedTools: true,
        responsesOptionalParameters: true,
        responsesHttpContinuation: true,
        conversationModels: true,
        resourceInput: true,
        serviceTiers: ['auto', 'default', 'flex', 'priority', 'fast', 'ultrafast']
      });
      expect(capabilities.workspaceDirectTransfer).toEqual({
        apiVersion: 3,
        transport: true,
        upload: true,
        download: true,
        range: true,
        gitCommitBlob: true,
        maxChunkBytes: 256 * 1024
      });
    }
  });

  it('reports actual availability for core and on-demand commands', async () => {
    const commands = await detectRuntimeCommands();

    expect(commands.map((entry) => entry.id)).toEqual(['npx', 'git', 'python', 'pip']);
    expect(commands.some((entry) => entry.available)).toBe(true);
    expect(commands.every((entry) => entry.available || entry.version === undefined)).toBe(true);
    expect(normalizeVersion('pip', 'pip 25.1.1 from /usr/lib/python3/dist-packages/pip')).toBe(
      '25.1.1'
    );
    expect(normalizeVersion('git', 'git version 2.53.0')).toBe('2.53.0');
    expect(normalizeVersion('python', 'Python 3.14.4')).toBe('3.14.4');
  });

  it('passes the fixed version command through cmd.exe on Windows without extra quoting', async () => {
    const execFile = vi.fn((...input: unknown[]) => {
      const callback = input.at(-1) as (
        error: Error | null,
        result: { stdout: string; stderr: string }
      ) => void;
      callback(null, { stdout: 'git version 2.53.0', stderr: '' });
      return {};
    });
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

    vi.doMock('node:child_process', () => ({ execFile }));
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    try {
      vi.resetModules();
      const { detectRuntimeCommands: detectWindowsRuntimeCommands } =
        await import('../../src/runtime-command-detector.js');

      await detectWindowsRuntimeCommands();

      const gitInvocation = execFile.mock.calls.find(
        ([command, args]) => command === 'cmd.exe' && (args as string[]).at(-1) === 'git --version'
      );
      expect(gitInvocation).toBeDefined();
      expect(gitInvocation?.[1]).toEqual(['/d', '/s', '/c', 'git --version']);
    } finally {
      if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor);
      vi.doUnmock('node:child_process');
      vi.resetModules();
    }
  });

  it('reports both the Node application version and the Node.js runtime version', () => {
    const capabilities = detectCapabilities({
      codex: 'definitely-not-installed-codex',
      claudeCode: 'definitely-not-installed-claude'
    });

    expect(capabilities.nodeAppVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(capabilities.nodeVersion).toBe(process.version);
    expect(capabilities.platform).toBe(reportedPlatform());
    expect(capabilities.metadata).toEqual(
      expect.objectContaining({ osRelease: expect.any(String), osVersion: expect.any(String) })
    );
  });

  it('maps macOS to the stable wire-platform value', () => {
    expect(reportedPlatform('darwin')).toBe('macos');
  });

  it('reprobes every 60 seconds, reports only capability changes, and clears the timer on stop', async () => {
    vi.useFakeTimers();
    try {
      const initial = detectCapabilities({
        codex: 'definitely-not-installed-codex',
        claudeCode: 'definitely-not-installed-claude'
      });
      let current = initial;
      const sent: { type: string; payload: unknown }[] = [];
      const connector = new NodeConnector({
        reconnect: false,
        capabilities: initial,
        capabilityDetector: () => current
      });
      connectTestSocket(connector, {
        readyState: 1,
        OPEN: 1,
        send(raw: string) {
          sent.push(JSON.parse(raw) as { type: string; payload: unknown });
        },
        close() {}
      });
      (connector as unknown as { startCapabilityRefresh: () => void }).startCapabilityRefresh();

      await vi.advanceTimersByTimeAsync(59_999);
      expect(sent).toHaveLength(0);

      current = { ...initial, codex: { available: true, version: 'codex 1.0.0' } };
      await vi.advanceTimersByTimeAsync(1);
      expect(sent.filter((message) => message.type === 'capabilities')).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(sent.filter((message) => message.type === 'capabilities')).toHaveLength(1);

      connector.stop();
      current = { ...current, claudeCode: { available: true, version: 'claude 1.0.0' } };
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sent.filter((message) => message.type === 'capabilities')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['0', '1'])(
    'Probe failure preserves Node metadata and safely disables external Runners (supervised=%s)',
    async (supervised) => {
      vi.stubEnv('MAR_NODE_SUPERVISED', supervised);
      try {
        const initial = {
          ...detectCapabilities({
            codex: 'definitely-not-installed-codex',
            claudeCode: 'definitely-not-installed-claude'
          }),
          codex: { available: true, version: 'codex 1.0.0' },
          claudeCode: { available: true, version: 'claude 1.0.0' }
        };
        const sent: { type: string; payload: NodeCapabilities }[] = [];
        const connector = new NodeConnector({
          reconnect: false,
          capabilities: initial,
          capabilityDetector: () => {
            throw new Error('PROBE_FAILED');
          }
        });
        connectTestSocket(connector, {
          readyState: 1,
          OPEN: 1,
          send(raw: string) {
            const message = JSON.parse(raw) as { type: string; payload: NodeCapabilities };
            if (message.type === 'capabilities') sent.push(message);
          },
          close() {}
        });

        await (
          connector as unknown as { refreshCapabilities: () => Promise<void> }
        ).refreshCapabilities();

        expect(sent).toHaveLength(1);
        expect(sent[0]?.payload).toEqual({
          ...initial,
          metadata: {
            ...initial.metadata,
            ...(supervised === '1' ? { supervisedUpgrade: true } : {})
          },
          codex: { available: false },
          claudeCode: { available: false },
          openCode: { available: false },
          computerUse: expect.objectContaining({
            apiVersion: 1,
            enabled: false,
            state: 'DISABLED',
            backend: 'PYAUTOGUI'
          })
        });
        await connector.stop();
      } finally {
        vi.unstubAllEnvs();
      }
    }
  );
});
