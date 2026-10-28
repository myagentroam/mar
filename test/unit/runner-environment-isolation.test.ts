import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { discoverAllNativeSessions } from '../../mar-node/src/native-session-history.js';
import { nativeTranscriptAdapter } from '../../mar-node/src/native-transcript-adapters.js';
import {
  isolatedRunnerEnvironment,
  isolateRunnerEnvironment
} from '../support/isolate-runner-environment.js';
import { cleanupSharedAuditFixture } from '../support/shared-audit-fixture-cleanup.js';

describe('Node E2E runner environment isolation', () => {
  it('isolates spawned Runner environments without mutating inherited configuration', () => {
    const inherited = {
      HOME: '/host',
      CODEX_HOME: '/host/codex',
      CLAUDE_CONFIG_DIR: '/host/claude',
      OPENAI_API_KEY: 'fixture-only',
      PATH: '/bin'
    };
    const child = isolatedRunnerEnvironment('/fixture', inherited);
    expect(child).toMatchObject({
      HOME: '/fixture',
      CODEX_HOME: '/fixture/.codex',
      CLAUDE_CONFIG_DIR: '/fixture/.claude',
      PATH: '/bin'
    });
    expect(child.OPENAI_API_KEY).toBeUndefined();
    expect(inherited.CODEX_HOME).toBe('/host/codex');
  });
  it('ignores inherited runner homes and restores them after fixture teardown', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mar-runner-isolation-'));
    const inherited = join(directory, 'inherited-home');
    const isolated = join(directory, 'fixture-home');
    const inheritedSessions = join(inherited, '.codex', 'sessions');
    await mkdir(inheritedSessions, { recursive: true });
    await mkdir(isolated);
    await writeFile(
      join(inheritedSessions, 'synthetic.jsonl'),
      `${JSON.stringify({ type: 'session_meta', payload: { id: 'outside', cwd: directory } })}\n`
    );
    vi.stubEnv('HOME', inherited);
    vi.stubEnv('CODEX_HOME', inheritedSessions);
    vi.stubEnv('CLAUDE_CONFIG_DIR', inherited);
    vi.stubEnv('OPENCODE_CONFIG', join(inherited, 'config.json'));
    const restore = isolateRunnerEnvironment(isolated);
    try {
      expect(nativeTranscriptAdapter('codex')!.transcriptRoot()).toBe(
        join(isolated, '.codex', 'sessions')
      );
      expect(nativeTranscriptAdapter('claude-code')!.transcriptRoot()).toBe(
        join(isolated, '.claude', 'projects')
      );
      expect(process.env.CODEX_HOME).toBe(join(isolated, '.codex'));
      expect(process.env.CLAUDE_CONFIG_DIR).toBe(join(isolated, '.claude'));
      expect(process.env.OPENCODE_CONFIG).toBeUndefined();
      expect(await discoverAllNativeSessions('codex')).toEqual([]);
      expect(await discoverAllNativeSessions('claude-code')).toEqual([]);
    } finally {
      restore();
      try {
        expect(process.env.HOME).toBe(inherited);
        expect(process.env.CODEX_HOME).toBe(inheritedSessions);
      } finally {
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
});

describe('shared audit fixture cleanup', () => {
  it.each(['connector', 'actor', 'server'] as const)(
    'attempts all resource cleanup before restoring the environment when %s fails',
    async (failedResource) => {
      const calls: string[] = [];
      const failure = new Error(`${failedResource} cleanup failed`);
      const cleanup = (name: string) => async () => {
        calls.push(name);
        if (name === failedResource) throw failure;
      };
      await expect(
        cleanupSharedAuditFixture({
          stopConnector: cleanup('connector'),
          disposeActor: cleanup('actor'),
          closeServer: cleanup('server'),
          restoreEnvironment: () => {
            calls.push('restore');
          },
          removeDirectory: cleanup('directory')
        })
      ).rejects.toBe(failure);
      expect(calls).toEqual(['connector', 'actor', 'server', 'restore', 'directory']);
    }
  );

  it('waits for cleanup and preserves the primary failure over cleanup failures', async () => {
    const calls: string[] = [];
    const primary = new Error('test failure');
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const result = cleanupSharedAuditFixture({
      stopConnector: async () => {
        calls.push('connector');
        throw new Error('cleanup failure');
      },
      disposeActor: async () => {
        calls.push('actor');
        await pending;
      },
      closeServer: async () => {
        calls.push('server');
      },
      restoreEnvironment: () => {
        calls.push('restore');
      },
      removeDirectory: async () => {
        calls.push('directory');
      },
      primaryFailure: { error: primary }
    });
    await vi.waitFor(() => expect(calls).toEqual(['connector', 'actor']));
    release();
    await expect(result).rejects.toBe(primary);
    expect(calls).toEqual(['connector', 'actor', 'server', 'restore', 'directory']);
  });
});
