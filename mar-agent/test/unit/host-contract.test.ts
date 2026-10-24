import { describe, expect, it } from 'vitest';
import {
  MAR_AGENT_HOST_API_VERSION,
  MarAgentError,
  negotiateHost,
  selectExecutionShell,
  type HostDescription,
  type MarAgentHostCapability
} from '../../src/index.js';

const capabilities = [
  'workspace.read',
  'workspace.patch',
  'process.manage',
  'user-input.request',
  'event.publish'
] as const;

const host = (
  apiVersion: string,
  values: readonly MarAgentHostCapability[] = capabilities
): HostDescription => ({
  apiVersion,
  mode: 'normal',
  homeDirectory: '/tmp/mar-home',
  platform: 'linux',
  capabilities: values,
  limits: { maxProcesses: 8, maxOutputBytes: 1_000_000, maxExecutionMs: 120_000 }
});

describe('host negotiation', () => {
  it('keeps Mission outside the Agent Host capability contract', () => {
    expect(host('1.0').capabilities).not.toContain('mission.tools');
  });

  it('accepts the same version and higher compatible minor', () => {
    expect(MAR_AGENT_HOST_API_VERSION).toBe('1.0');
    expect(negotiateHost(host('1.0')).apiVersion).toBe('1.0');
    expect(negotiateHost(host('1.7')).apiVersion).toBe('1.7');
  });

  it('ignores unknown optional capabilities', () => {
    const description = host('1.0', [...capabilities, 'future.optional' as MarAgentHostCapability]);
    expect(negotiateHost(description)).toBe(description);
  });

  it('rejects another major or missing required capability', () => {
    for (const description of [
      host('2.0'),
      host('0.9'),
      ...capabilities.map((required) =>
        host(
          '1.0',
          capabilities.filter((capability) => capability !== required)
        )
      )
    ]) {
      try {
        negotiateHost(description);
        expect.fail('expected incompatible host');
      } catch (error) {
        expect(error).toBeInstanceOf(MarAgentError);
        expect((error as MarAgentError).code).toBe('MAR_AGENT_HOST_INCOMPATIBLE');
      }
    }
  });

  it('selects Bash before sh and accurately reports the fallback', () => {
    expect(selectExecutionShell({}, 'linux', (path) => path === '/bin/bash')).toEqual({
      name: 'bash',
      path: '/bin/bash'
    });
    expect(selectExecutionShell({}, 'linux', (path) => path === '/bin/sh')).toEqual({
      name: 'sh',
      path: '/bin/sh'
    });
  });

  it('selects pwsh, Windows PowerShell and cmd in order', () => {
    const environment = {
      Path: 'C:\\PowerShell7;C:\\WindowsPowerShell',
      ComSpec: 'C:\\Windows\\cmd.exe'
    };
    expect(
      selectExecutionShell(environment, 'win32', (path) =>
        [
          'C:\\PowerShell7\\pwsh.exe',
          'C:\\WindowsPowerShell\\powershell.exe',
          environment.ComSpec
        ].includes(path)
      )
    ).toEqual({ name: 'pwsh', path: 'C:\\PowerShell7\\pwsh.exe' });
    expect(
      selectExecutionShell(environment, 'win32', (path) =>
        ['C:\\WindowsPowerShell\\powershell.exe', environment.ComSpec].includes(path)
      )
    ).toEqual({ name: 'powershell', path: 'C:\\WindowsPowerShell\\powershell.exe' });
    expect(selectExecutionShell({ ComSpec: environment.ComSpec }, 'win32', () => true)).toEqual({
      name: 'cmd',
      path: environment.ComSpec
    });
  });
});
