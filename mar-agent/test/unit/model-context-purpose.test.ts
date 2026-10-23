import { afterEach, describe, expect, it } from 'vitest';
import type { ModelMessage } from '../../src/agent-core/model/contracts.js';
import { JsonlSessionStore } from '../../src/agent-core/session/store/index.js';
import { answer, cleanupCoreFixtures, fixture } from './support/core-extension-fixture.js';

afterEach(cleanupCoreFixtures);

describe('Native model context purpose', () => {
  it.each([
    ['OPENAI_RESPONSES', undefined],
    ['OPENAI_RESPONSES', 'private'],
    ['ANTHROPIC_MESSAGES', 'private'],
    ['ANTHROPIC_MESSAGES', undefined]
  ] as const)(
    'persists and restores the event purpose for %s with context kind %s, excluding Compact output',
    async (protocol, contextKind) => {
      const item =
        protocol === 'OPENAI_RESPONSES'
          ? { type: 'reasoning', encrypted_content: 'opaque-state' }
          : { type: 'thinking', thinking: '', signature: 'opaque-signature' };
      const f = await fixture(
        [],
        () => [
          {
            type: 'response.item',
            provider: protocol,
            ...(contextKind === undefined ? {} : { contextKind }),
            item
          },
          ...answer()
        ],
        false,
        true,
        {},
        protocol
      );
      expect(await f.session.run({ prompt: 'Save native state.' }).result()).toMatchObject({
        status: 'completed'
      });
      expect(await f.session.run({ prompt: 'Restore native state.' }).result()).toMatchObject({
        status: 'completed'
      });
      const restored = f.adapter.requests[1]!.messages.filter(
        (message) => message.role === 'provider'
      );
      expect(restored).toHaveLength(1);
      const restoredKind =
        contextKind ?? (protocol === 'ANTHROPIC_MESSAGES' ? 'private' : undefined);
      expect(restored[0]).toEqual({
        role: 'provider',
        content: '',
        provider: protocol,
        providerModelId: 'test',
        ...(restoredKind === undefined ? {} : { contextKind: restoredKind }),
        item
      });
      expect(await f.session.compact().result()).toMatchObject({ status: 'completed' });
      await f.agent.dispose();
      const store = await JsonlSessionStore.open(f.home);
      try {
        const records = await store.read(f.session.id);
        const native = records.filter(
          (record) =>
            record.type === 'model.context' && (record.payload as ModelMessage).role === 'provider'
        );
        expect(native).toHaveLength(2);
        for (const record of native) {
          expect(record.payload).toEqual({
            role: 'provider',
            content: '',
            provider: protocol,
            providerModelId: 'test',
            ...(contextKind === undefined ? {} : { contextKind }),
            item
          });
        }
      } finally {
        await store.close();
      }
    }
  );
});
