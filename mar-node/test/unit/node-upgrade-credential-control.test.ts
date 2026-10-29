import { describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '@myagentroam/protocol';
import { NodeUpgradeCredentialControl } from '../../src/service/node-upgrade-credential-control.js';

describe('upgrade report credential control', () => {
  it('requires the server feature and correlates the response on the authenticated channel', async () => {
    const send = vi.fn();
    const control = new NodeUpgradeCredentialControl(send);
    await expect(control.request('attempt')).rejects.toThrow('NODE_UPGRADE_CREDENTIAL_UNAVAILABLE');
    control.setFeatures({ nodeUpgradeProgress: { apiVersion: 1 } });
    const pending = control.request('attempt');
    const request = send.mock.calls[0]![0];
    expect(request.type).toBe('node.upgrade.credential.request');
    control.handle(
      createEnvelope(
        'node.upgrade.credential.response',
        { token: 'x'.repeat(43) },
        { replyTo: 'other' }
      )
    );
    control.handle(
      createEnvelope(
        'node.upgrade.credential.response',
        { token: 'x'.repeat(43) },
        { replyTo: request.id }
      )
    );
    await expect(pending).resolves.toBe('x'.repeat(43));
  });
  it('rejects a pending request on disconnect and disables the feature', async () => {
    const control = new NodeUpgradeCredentialControl(() => undefined);
    control.setFeatures({ nodeUpgradeProgress: { apiVersion: 1 } });
    const pending = control.request('attempt');
    control.disconnect();
    await expect(pending).rejects.toThrow('NODE_UPGRADE_CREDENTIAL_UNAVAILABLE');
    await expect(control.request('attempt')).rejects.toThrow('NODE_UPGRADE_CREDENTIAL_UNAVAILABLE');
  });
});
