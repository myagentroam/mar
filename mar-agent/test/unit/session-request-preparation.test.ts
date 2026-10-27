import { afterEach, describe, expect, it } from 'vitest';
import type { SessionExtensionContext } from '../../src/extensions.js';
import type { ModelRequest } from '../../src/model/contracts.js';
import { prepareSessionModelRequest } from '../../src/sdk/request-preparation.js';
import { JsonlSessionStore } from '../../src/session/store/index.js';
import { restoreMessages } from '../../src/runtime/context/restore.js';
import { fixture, answer, cleanupCoreFixtures } from './support/core-extension-fixture.js';

afterEach(cleanupCoreFixtures);

describe.each(['OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES'] as const)(
  'Session request preparation %s',
  (protocol) => {
    it('projects captured messages and tools without mutating history or dispatch metadata', () => {
      const candidate: ModelRequest = {
        system: 'stable system',
        systemBlocks: [{ text: 'stable system', cache: true }],
        messages: [{ role: 'user', content: 'history' }],
        tools: ['read', 'deferred'].map((name) => ({
          name,
          description: name,
          inputSchema: { type: 'object' }
        })),
        promptCacheKey: 'session',
        reasoningEffort: 'low',
        requestReasoningEffort: 'high',
        onAttemptDiagnostic: () => undefined
      };
      const before = JSON.stringify(candidate);
      const request = prepareSessionModelRequest(
        candidate,
        { protocol, inputCapabilities: ['TEXT'] },
        [{ index: 0, kind: 'prompt', content: 'captured context' }],
        [candidate.tools[0]!],
        false
      );
      expect(request.messages.map((message) => message.content)).toEqual([
        'captured context',
        'history'
      ]);
      expect(request.tools.map((tool) => tool.name)).toEqual(
        protocol === 'OPENAI_RESPONSES' ? ['read'] : ['read', 'deferred']
      );
      expect(request).toMatchObject({
        promptCacheKey: 'session',
        reasoningEffort: 'low',
        requestReasoningEffort: 'high'
      });
      expect(request.onAttemptDiagnostic).toBe(candidate.onAttemptDiagnostic);
      expect(request.systemBlocks).toBe(candidate.systemBlocks);
      expect(JSON.stringify(candidate)).toBe(before);
    });

    it.each(['complete', 'fail', 'cancel'] as const)(
      'keeps late steer durable and only publishes a dispatched candidate after a suspended Hook (%s)',
      async (outcome) => {
        let context!: SessionExtensionContext;
        const f = await fixture(
          [
            {
              id: 'phase-request',
              apiVersion: '1.0',
              attachSession: (value) => {
                context = value;
              }
            }
          ],
          answer,
          false,
          true,
          {},
          protocol
        );
        expect((await f.session.run({ prompt: 'seed' }).result()).status).toBe('completed');
        const previous = await context.session.captureRequest();
        const entered = Promise.withResolvers<void>();
        const resume = Promise.withResolvers<void>();
        let armed = true;
        const unregister = context.hooks.intercept(
          'model.request',
          async (request, _call, next) => {
            if (!armed) return next(request);
            armed = false;
            entered.resolve();
            await resume.promise;
            if (outcome === 'fail') throw new Error('request Hook failed');
            return next({ ...request, system: request.system + '\nHOOK_ACCEPTED' });
          }
        );
        const handle = f.session.run({ prompt: 'prepared input' });
        try {
          await Promise.race([
            entered.promise,
            handle.result().then(() => {
              throw new Error('Execution ended before the Hook gate.');
            })
          ]);
          expect(await context.session.captureRequest()).toEqual(previous);
          expect(f.adapter.requests).toHaveLength(1);
          const receipt = await f.session.steer({
            expectedExecutionId: handle.executionId,
            clientMessageId: 'late-during-request',
            prompt: 'late steer'
          });
          expect(receipt.status).toBe('accepted');
          const cancelling = outcome === 'cancel' ? handle.cancel() : undefined;
          resume.resolve();
          await cancelling;
          expect((await handle.result()).status).toBe(
            outcome === 'complete' ? 'completed' : outcome === 'fail' ? 'failed' : 'cancelled'
          );
          if (outcome !== 'complete') {
            expect(f.adapter.requests).toHaveLength(1);
            expect(await context.session.captureRequest()).toEqual(previous);
          } else {
            expect(
              f.adapter.requests.some((request) => request.system.includes('HOOK_ACCEPTED'))
            ).toBe(true);
            expect(JSON.stringify((await context.session.captureRequest())!.request)).toContain(
              'late steer'
            );
          }
          // A later Execution must read the live view, not the discarded preparation view.
          await context.session.append({ content: 'after preparation', delivery: 'immediate' });
          expect(
            JSON.stringify(await context.session.messages({ view: 'request', limit: 1000 }))
          ).toContain('after preparation');
          expect((await f.session.run({ prompt: 'resume' }).result()).status).toBe('completed');
          expect(
            f.adapter.requests
              .at(-1)!
              .messages.filter((message) => message.content === 'late steer')
          ).toHaveLength(1);
          const store = await JsonlSessionStore.open(f.home);
          try {
            const records = await store.read(f.session.id);
            expect(
              records.filter(
                (record) =>
                  record.type === 'turn.user' &&
                  (record.payload as { prompt?: string }).prompt === 'late steer'
              )
            ).toHaveLength(1);
            expect(
              records.filter(
                (record) =>
                  record.type === 'model.context' &&
                  (record.payload as { content?: string }).content === 'late steer'
              )
            ).toHaveLength(1);
            const restored = await restoreMessages(store, f.session.id, records, {
              includeImages: false
            });
            expect(
              restored.messages.filter((message) => message.content === 'late steer')
            ).toHaveLength(1);
            expect(
              records.filter(
                (record) =>
                  record.executionId === handle.executionId &&
                  ['execution.completed', 'execution.failed', 'execution.cancelled'].includes(
                    record.type
                  )
              )
            ).toHaveLength(1);
          } finally {
            await store.close();
          }
        } finally {
          resume.resolve();
          await unregister.dispose();
          await handle.result();
        }
      }
    );
  }
);
