import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, type NodeEnvelope } from '@myagentroam/protocol';
import { RunAuthorizationControl } from '../../src/service/run-authorization-control.js';

const request = {
  userId: 7,
  workspaceId: 'workspace',
  sessionId: 'session',
  runner: 'mar-agent' as const,
  modelId: 'selected'
};
afterEach(() => vi.useRealTimers());

describe('execution resource control', () => {
  it('correlates fresh resources without accepting a response from another operation', async () => {
    const sent: NodeEnvelope[] = [];
    const control = new RunAuthorizationControl((envelope) => sent.push(envelope));
    control.connected();
    const pending = control.prepare(request);
    expect(sent[0]).toMatchObject({ type: 'execution.prepare', payload: request });
    const context = {
      secretEnvironment: { FRESH: 'new-resource' },
      gitConfiguration: { credentials: [] }
    };
    control.handle(
      createEnvelope(
        'schedule.authorize.response',
        { context: {} },
        {
          replyTo: sent[0]!.id
        }
      )
    );
    control.handle(
      createEnvelope(
        'execution.prepare.response',
        { context },
        {
          replyTo: sent[0]!.id
        }
      )
    );
    await expect(pending).resolves.toEqual(context);
    control.close();
  });

  it('fails pending preparation on disconnect and ignores replies from the old connection', async () => {
    const sent: NodeEnvelope[] = [];
    const control = new RunAuthorizationControl((envelope) => sent.push(envelope));
    control.connected();
    const first = expect(control.prepare(request)).rejects.toThrow('EXECUTION_SERVER_UNAVAILABLE');
    control.disconnected();
    await first;
    control.connected();
    const second = control.prepare(request);
    control.handle(
      createEnvelope(
        'execution.prepare.response',
        {
          context: { secretEnvironment: { STALE: 'old' } }
        },
        { replyTo: sent[0]!.id }
      )
    );
    control.handle(
      createEnvelope(
        'execution.prepare.response',
        {
          context: { secretEnvironment: { FRESH: 'new' } }
        },
        { replyTo: sent[1]!.id }
      )
    );
    await expect(second).resolves.toEqual({ secretEnvironment: { FRESH: 'new' } });
    control.close();
  });

  it.each(['invalid', 'denied', 'timeout'] as const)(
    'settles %s preparation explicitly',
    async (mode) => {
      vi.useFakeTimers();
      const sent: NodeEnvelope[] = [];
      const control = new RunAuthorizationControl((envelope) => sent.push(envelope));
      control.connected();
      const code =
        mode === 'invalid'
          ? 'EXECUTION_AUTH_RESPONSE_INVALID'
          : mode === 'denied'
            ? 'WORKSPACE_ACCESS_DENIED'
            : 'EXECUTION_AUTH_TIMEOUT';
      const pending = expect(control.prepare(request)).rejects.toThrow(code);
      if (mode === 'timeout') await vi.advanceTimersByTimeAsync(15_000);
      else
        control.handle(
          createEnvelope(
            'execution.prepare.response',
            mode === 'invalid' ? {} : { error: { code, message: 'Workspace access is denied.' } },
            {
              replyTo: sent[0]!.id
            }
          )
        );
      await pending;
      control.close();
    }
  );
});
