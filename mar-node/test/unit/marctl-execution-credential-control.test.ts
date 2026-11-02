import { createEnvelope, type NodeEnvelope } from '@myagentroam/protocol';
import { expect, it, vi } from 'vitest';
import { MarctlExecutionCredentialControl } from '../../src/service/marctl-execution-credential-control.js';

const parentToken = `marctl_user_e30.${'a'.repeat(43)}`;
const token = `marctl_user_e30.${'b'.repeat(43)}`;
const request = {
  parentToken,
  workspaceId: 'workspace',
  sessionId: 'child',
  executionId: 'execution',
  userId: 7
};

it('accepts only the correlated credential response on the negotiated connection', async () => {
  const send = vi.fn<(envelope: NodeEnvelope) => void>();
  const control = new MarctlExecutionCredentialControl(send);
  control.connected();
  await expect(control.request(request)).rejects.toThrow(
    'MARCTL_EXECUTION_AUTHORIZATION_UNAVAILABLE'
  );
  control.setFeatures({ marctlExecutionCredential: { apiVersion: 1 } });
  await expect(control.request(request)).rejects.toThrow(
    'MARCTL_EXECUTION_AUTHORIZATION_UNAVAILABLE'
  );
  control.setFeatures({ marctlExecutionCredential: { apiVersion: 2 } });
  const result = control.request(request);
  const envelope = send.mock.calls[0]![0];
  expect(
    control.handle({
      ...createEnvelope('marctl.execution-credential.response', { token }),
      replyTo: 'wrong'
    })
  ).toBe(true);
  expect(
    control.handle({
      ...createEnvelope('marctl.execution-credential.response', { token }),
      replyTo: envelope.id
    })
  ).toBe(true);
  await expect(result).resolves.toBe(token);
  control.disconnected();
});

it('rejects malformed replies and disconnects without exposing token values', async () => {
  let sent: NodeEnvelope | undefined;
  const control = new MarctlExecutionCredentialControl((envelope) => {
    sent = envelope;
  });
  control.connected();
  control.setFeatures({ marctlExecutionCredential: { apiVersion: 2 } });
  const invalid = control.request(request);
  control.handle({
    ...createEnvelope('marctl.execution-credential.response', { token: 'invalid' }),
    replyTo: sent!.id
  });
  await expect(invalid).rejects.toThrow('MARCTL_EXECUTION_AUTHORIZATION_INVALID');
  const pending = control.request(request);
  control.disconnected();
  await expect(pending).rejects.toThrow('MARCTL_EXECUTION_AUTHORIZATION_UNAVAILABLE');
});
