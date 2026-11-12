import { describe, expect, it } from 'vitest';
import {
  RemoteDesktopAdmission,
  type DesktopAdmissionBinding
} from '../../src/remote-desktop-admission.js';

const identity = { userId: 1, sessionHash: 'session-a', workbenchConnectionId: 'page-a' };
const binding = (id: string, path: 'DIRECT' | 'RELAY' = 'DIRECT'): DesktopAdmissionBinding => ({
  ...identity,
  attachmentId: id,
  requestId: `request-${id}`,
  nodeId: 'node-a',
  nodeGeneration: 'generation-a',
  desktopGeneration: 'desktop-a',
  topologyRevision: 1,
  mode: 'VIEW',
  path
});

function dispatchAndPrepare(admission: RemoteDesktopAdmission, id: string, now = 1_000): void {
  expect(admission.reserve(binding(id), now)).toBeDefined();
  expect(admission.dispatched(id, now)).toBe(true);
  expect(admission.prepared(id, 'node-a', 'generation-a', now)).toBe(true);
}

describe('remote desktop admission', () => {
  it('retires only disconnected-page closing records after their own lease expires', () => {
    const admission = new RemoteDesktopAdmission();
    const disconnected = binding('disconnected');
    const connected = { ...binding('connected'), workbenchConnectionId: 'another-page' };
    for (const entry of [disconnected, connected]) {
      expect(admission.reserve(entry, 1_000)).toBeDefined();
      expect(admission.dispatched(entry.attachmentId, 1_000)).toBe(true);
    }
    admission.beginClose('connected');
    admission.closeForConnection('page-a', 'DIRECT');
    expect(admission.retireExpiredGonePages(30_999, 'DIRECT')).toHaveLength(0);
    expect(
      admission.retireExpiredGonePages(31_000, 'DIRECT').map((entry) => entry.attachmentId)
    ).toEqual(['disconnected']);
    expect(admission.get('connected')?.phase).toBe('CLOSING');
    expect(admission.settled('disconnected', 'node-a', 'generation-a')).toBe(false);
  });
  it('retires only old-generation bookkeeping after a new authenticated generation arrives', () => {
    const admission = new RemoteDesktopAdmission();
    for (let i = 0; i < 4; i++) {
      const entry = binding(`old-${i}`, i % 2 ? 'RELAY' : 'DIRECT');
      expect(admission.reserve(entry, 1_000)).toBeDefined();
      expect(admission.dispatched(entry.attachmentId, 1_000)).toBe(true);
    }
    admission.closeForNode('node-a');
    admission.expire(100_000);
    expect(admission.retireOtherGenerations('node-a', 'generation-a', 'DIRECT')).toHaveLength(0);
    expect(admission.countNode('node-a')).toBe(4);
    expect(admission.retireOtherGenerations('node-a', 'generation-b', 'DIRECT')).toHaveLength(2);
    expect(admission.retireOtherGenerations('node-a', 'generation-b', 'RELAY')).toHaveLength(2);
    expect(admission.countNode('node-a')).toBe(0);
    expect(admission.settled('old-0', 'node-a', 'generation-a')).toBe(false);
    expect(admission.settled('old-0', 'node-a', 'generation-b')).toBe(false);
    expect(
      admission.reserve({ ...binding('new'), nodeGeneration: 'generation-b' }, 101_000)
    ).toBeDefined();
  });
  it('tracks more than four Direct and relay attachments independently through cleanup', () => {
    const admission = new RemoteDesktopAdmission();
    for (let i = 0; i < 4; i++)
      expect(
        admission.reserve(binding(`id-${i}`, i % 2 ? 'RELAY' : 'DIRECT'), 1_000)
      ).toBeDefined();
    expect(admission.reserve(binding('fifth'), 1_000)).toBeDefined();
    expect(admission.dispatched('id-0', 1_000)).toBe(true);
    expect(admission.beginClose('id-0')?.phase).toBe('CLOSING');
    expect(admission.reserve(binding('sixth'), 1_000)).toBeDefined();
    expect(admission.settled('id-0', 'node-a', 'old-generation')).toBe(false);
    expect(admission.settled('id-0', 'node-a', 'generation-a')).toBe(true);
    expect(admission.beginClose('id-1')?.dispatched).toBe(false);
    expect(admission.countNode('node-a')).toBe(4);
  });

  it('binds cancellation and readiness to the exact authenticated page and Node generation', () => {
    const admission = new RemoteDesktopAdmission();
    dispatchAndPrepare(admission, 'first');
    expect(admission.open('first', 'node-a', 'old-generation', 1_100)).toBe(false);
    expect(admission.open('first', 'node-a', 'generation-a', 1_100)).toBe(true);
    expect(admission.attached('first', 'node-a', 'generation-a', 1_200)).toBe(true);
    expect(
      admission.browserReady('first', { ...identity, workbenchConnectionId: 'page-b' }, 1_300)
    ).toBe(false);
    expect(
      admission.closeForBrowser('first', { ...identity, sessionHash: 'other' })
    ).toBeUndefined();
    expect(admission.active('first', 'node-a', 'generation-a', 1_300)).toBe(false);
    expect(admission.browserReady('first', identity, 1_300)).toBe(true);
    expect(admission.active('first', 'node-a', 'generation-a', 1_400)).toBe(true);
    expect(admission.closeForBrowser('first', identity)?.phase).toBe('CLOSING');
    expect(admission.browserReady('first', identity, 1_500)).toBe(false);
    expect(admission.active('first', 'node-a', 'generation-a', 1_500)).toBe(false);
  });

  it('does not extend OPEN or setup deadlines when heartbeat succeeds', () => {
    const admission = new RemoteDesktopAdmission();
    dispatchAndPrepare(admission, 'pending');
    expect(admission.heartbeat('pending', identity, 15_999)).toBe(true);
    expect(admission.open('pending', 'node-a', 'generation-a', 16_000)).toBe(false);
    expect(admission.expire(16_000).map((entry) => entry.attachmentId)).toEqual(['pending']);
    expect(admission.countNode('node-a')).toBe(1);
    expect(admission.settled('pending', 'node-a', 'generation-a')).toBe(true);

    dispatchAndPrepare(admission, 'setup', 20_000);
    expect(admission.open('setup', 'node-a', 'generation-a', 20_001)).toBe(true);
    expect(admission.attached('setup', 'node-a', 'generation-a', 20_002)).toBe(true);
    expect(admission.heartbeat('setup', identity, 35_000)).toBe(true);
    expect(admission.browserReady('setup', identity, 35_001)).toBe(false);
    expect(admission.expire(35_001).map((entry) => entry.attachmentId)).toEqual(['setup']);
  });

  it('retains early page readiness without activating before ordered Node events', () => {
    const admission = new RemoteDesktopAdmission();
    dispatchAndPrepare(admission, 'racing');
    expect(admission.browserReady('racing', identity, 1_100)).toBe(true);
    expect(admission.active('racing', 'node-a', 'generation-a', 1_100)).toBe(false);
    expect(admission.open('racing', 'node-a', 'generation-a', 1_200)).toBe(true);
    expect(admission.attached('racing', 'node-a', 'generation-a', 1_300)).toBe(true);
    expect(admission.active('racing', 'node-a', 'generation-a', 1_400)).toBe(true);
  });

  it('rejects duplicate identities and does not expose mutable records', () => {
    const admission = new RemoteDesktopAdmission();
    const first = admission.reserve(binding('first'), 1_000)!;
    expect(
      admission.reserve({ ...binding('second'), requestId: first.requestId }, 1_000)
    ).toBeUndefined();
    (first as { mode: string }).mode = 'CONTROL';
    expect(admission.get('first')?.mode).toBe('VIEW');
    expect(admission.expire(16_000)).toHaveLength(1);
    expect(admission.countNode('node-a')).toBe(0);
  });

  it('fences matching pages on revocation without affecting other sessions', () => {
    const admission = new RemoteDesktopAdmission();
    expect(admission.reserve(binding('one'), 1_000)).toBeDefined();
    expect(admission.dispatched('one', 1_000)).toBe(true);
    expect(admission.reserve(binding('two'), 1_000)).toBeDefined();
    expect(admission.closeForSession('other')).toHaveLength(0);
    expect(admission.closeForSession(identity.sessionHash)).toHaveLength(2);
    expect(admission.countNode('node-a')).toBe(1);
    expect(admission.heartbeat('one', identity, 1_100)).toBe(false);
    expect(admission.closeForNode('node-a')).toHaveLength(0);
    expect(admission.settled('one', 'node-a', 'generation-a')).toBe(true);
    expect(admission.countNode('node-a')).toBe(0);
  });
});
