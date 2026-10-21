import { describe, expect, it, vi } from 'vitest';
import { getNodeHealth } from '../../src/health.js';
import { runRunnerProbe } from '../../src/operational.js';

describe('Node smoke', () => {
  it('reports a supported runtime platform', () => {
    expect(getNodeHealth()).toMatchObject({ status: 'ok', platform: process.platform });
  });

  it('records failed Runner probe diagnostics without logging its stdout', async () => {
    const log = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      const result = await runRunnerProbe(
        process.execPath,
        [
          '-e',
          'process.stdout.write("private output");process.stderr.write("probe failed");process.exit(9)'
        ],
        { timeoutMs: 3_000 }
      );
      expect(result).toMatchObject({ status: 9, stderr: 'probe failed' });
      const logged = log.mock.calls.map(([line]) => String(line)).join('');
      expect(logged).toContain('probe failed');
      expect(logged).not.toContain('private output');
    } finally {
      log.mockRestore();
    }
  });

  it('keeps authentication probe stderr out of Node logs', async () => {
    const log = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      const result = await runRunnerProbe(
        process.execPath,
        ['-e', 'process.stderr.write("private auth detail"); process.exit(9)'],
        { timeoutMs: 3_000, logStderr: false }
      );
      expect(result.status).toBe(9);
      const output = log.mock.calls.map(([line]) => String(line)).join('');
      expect(output).toContain('"exitCode":9');
      expect(output).not.toContain('private auth detail');
    } finally {
      log.mockRestore();
    }
  });
});
