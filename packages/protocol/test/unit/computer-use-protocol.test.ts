import { describe, expect, it } from 'vitest';
import {
  computerUseCapabilitySchema,
  computerUseDisableInputSchema,
  computerUseEnableInputSchema,
  computerUseEnableResultSchema,
  nodeCapabilitiesSchema,
  workbenchNodeOperationSchema
} from '../../src/index.js';

const base = {
  apiVersion: 1 as const,
  enabled: false,
  state: 'DISABLED' as const,
  backend: 'PYAUTOGUI' as const,
  supportsScreenshot: false,
  supportsInput: false,
  supportsUnicodePaste: false,
  supportsPrimaryDisplay: false,
  measuredAt: 1
};

describe('Computer Use protocol', () => {
  it('accepts valid lifecycle states and fixed operations', () => {
    expect(computerUseCapabilitySchema.parse(base)).toEqual(base);
    expect(
      computerUseEnableResultSchema.parse({
        capability: {
          ...base,
          enabled: true,
          state: 'AVAILABLE',
          supportsScreenshot: true,
          supportsInput: true,
          supportsUnicodePaste: true,
          supportsPrimaryDisplay: true
        }
      }).capability.state
    ).toBe('AVAILABLE');
    expect(computerUseEnableInputSchema.parse({ enabled: true })).toEqual({ enabled: true });
    expect(computerUseDisableInputSchema.parse({})).toEqual({});
    expect(workbenchNodeOperationSchema.parse('computer.use.enable')).toBe('computer.use.enable');
    expect(workbenchNodeOperationSchema.parse('computer.use.disable')).toBe('computer.use.disable');
  });

  it('rejects inconsistent or path-bearing capability data', () => {
    expect(
      computerUseCapabilitySchema.safeParse({ ...base, enabled: true, state: 'DISABLED' }).success
    ).toBe(false);
    expect(
      computerUseCapabilitySchema.safeParse({
        ...base,
        enabled: true,
        state: 'AVAILABLE',
        supportsScreenshot: true,
        supportsInput: true,
        supportsUnicodePaste: false,
        supportsPrimaryDisplay: true
      }).success
    ).toBe(false);
    expect(
      computerUseCapabilitySchema.safeParse({
        ...base,
        enabled: true,
        state: 'UNAVAILABLE'
      }).success
    ).toBe(false);
    expect(
      computerUseCapabilitySchema.safeParse({
        ...base,
        runtimeExecutable: 'C:\\private\\python.exe'
      }).success
    ).toBe(false);
  });

  it('projects Computer Use through Node capabilities', () => {
    const result = nodeCapabilitiesSchema.parse({
      platform: 'windows',
      architecture: 'x64',
      nodeVersion: 'v22.13.0',
      codex: { available: false },
      claudeCode: { available: false },
      computerUse: base
    });
    expect(result.computerUse?.state).toBe('DISABLED');
  });
});
