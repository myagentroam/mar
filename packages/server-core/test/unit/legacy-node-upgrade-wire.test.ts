import { describe, expect, it } from 'vitest';
import {
  legacyNodeUpgradeEnvelope,
  parseLegacyNodeUpgradeEnvelope
} from '../../src/legacy-node-upgrade-wire.js';

describe('v2 Node upgrade control wire', () => {
  it('accepts only authentication, heartbeat, minimal capabilities, and correlated responses', () => {
    const base = { version: 2, id: 'frame-1' };
    expect(
      parseLegacyNodeUpgradeEnvelope({
        ...base,
        type: 'authenticate',
        payload: { nodeId: 'node-1', credential: 'fixture' }
      }).type
    ).toBe('authenticate');
    expect(parseLegacyNodeUpgradeEnvelope({ ...base, type: 'heartbeat', payload: {} }).type).toBe(
      'heartbeat'
    );
    expect(
      parseLegacyNodeUpgradeEnvelope({
        ...base,
        type: 'capabilities',
        payload: {
          platform: 'linux',
          architecture: 'x64',
          nodeAppVersion: '0.11.37',
          nodeVersion: '22',
          metadata: { supervisedUpgrade: true },
          unrelatedBusinessCapability: { arbitrary: true }
        }
      }).payload
    ).toEqual({
      platform: 'linux',
      architecture: 'x64',
      nodeAppVersion: '0.11.37',
      nodeVersion: '22',
      metadata: { supervisedUpgrade: true }
    });
    expect(
      parseLegacyNodeUpgradeEnvelope({
        ...base,
        type: 'node.response',
        replyTo: 'request-1',
        payload: { result: { state: 'WAITING_FOR_RUNS' } }
      }).type
    ).toBe('node.response');
    expect(() =>
      parseLegacyNodeUpgradeEnvelope({ ...base, type: 'register', payload: {} })
    ).toThrow();
    expect(() =>
      parseLegacyNodeUpgradeEnvelope({ ...base, type: 'workbench.event', payload: {} })
    ).toThrow();
    expect(() =>
      parseLegacyNodeUpgradeEnvelope({ ...base, type: 'node.response', payload: {} })
    ).toThrow();
    expect(() =>
      parseLegacyNodeUpgradeEnvelope({ ...base, version: 1, type: 'heartbeat', payload: {} })
    ).toThrow();
  });

  it('encodes v2 replies with their original correlation', () => {
    expect(
      legacyNodeUpgradeEnvelope('ack', { type: 'heartbeat' }, { id: 'reply', replyTo: 'frame-1' })
    ).toEqual({
      version: 2,
      id: 'reply',
      type: 'ack',
      replyTo: 'frame-1',
      payload: { type: 'heartbeat' }
    });
  });
});
