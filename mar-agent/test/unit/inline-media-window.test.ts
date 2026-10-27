import { describe, expect, it, vi } from 'vitest';
import type { ModelMessage, ModelRequest } from '../../src/model/contracts.js';
import { ResourceInputProjection } from '../../src/sdk/resource-input.js';
import { assertInlineMediaBudget } from '../../src/model/inline-media-budget.js';
import { projectModelRequest } from '../../src/sdk/model-input-projection.js';
import {
  INLINE_MEDIA_POLICY,
  inlineMediaGcAnchored,
  inlineMediaHistory
} from '../../src/session/inline-media.js';
import type { SessionRecord } from '../../src/session/store/types.js';
import { forkedPayload } from '../../src/session/store/jsonl/history.js';

const MiB = 1_048_576;
function imageMessage(id: string, bytes = 3 * MiB): ModelMessage {
  return {
    role: 'tool',
    callId: id,
    content: id,
    images: [{ mimeType: 'image/png', resourceId: id, byteSize: bytes }]
  };
}
const request = (messages: ModelMessage[]): ModelRequest => ({ system: '', tools: [], messages });
function fixture(history: ModelMessage[] = []) {
  const states: unknown[] = [];
  const store = {
    readResource: vi.fn(async (_: string, id: string) => ({
      mimeType: 'image/png',
      dataBase64: Buffer.alloc(id === 'small' ? 1024 : 3 * MiB).toString('base64')
    }))
  };
  const projection = new ResourceInputProjection(false, store, 'session', history, {
    persist: async (state) => {
      states.push(state);
    }
  });
  return { projection, store, states };
}

describe('inline media window', () => {
  const record = (type: string, payload: unknown, sequence: number): SessionRecord => ({
    schemaVersion: 1,
    recordId: `record-${sequence}`,
    sequence,
    timestamp: '2026-10-25T00:00:00Z',
    sessionId: 'session',
    type,
    payload
  });
  const hardGc = (
    evictedThrough: { sourceId: string; imageIndex: number },
    consideredThrough: { sourceId: string; imageIndex: number }
  ) => ({
    reason: 'HARD_LIMIT' as const,
    state: { version: 1 as const, evictedThrough, consideredThrough },
    beforeBytes: 13 * MiB,
    afterBytes: 5 * MiB
  });
  it('proposes mature oldest-first reclamation without independently changing the window', async () => {
    const { projection, states } = fixture();
    const a = imageMessage('a');
    const first = await projection.prepare(request([a]));
    await projection.complete(first);
    expect((await projection.prepare(request([a]))).messages[0]?.images).toHaveLength(1);
    const b = imageMessage('b');
    const second = await projection.prepare(request([a, b]));
    expect(second.messages.every((m) => m.images?.length === 1)).toBe(true);
    await projection.complete(second);
    const proposal = await projection.gcCandidate();
    expect(proposal).toMatchObject({
      reason: 'SOFT_LIMIT',
      state: { evictedThrough: { sourceId: 'tool:a' } }
    });
    expect(
      (await projection.prepare(request([a, b]))).messages.map((m) => m.images?.length)
    ).toEqual([1, 1]);
    expect(states.at(-1)).toMatchObject({
      consideredThrough: { sourceId: 'tool:b', imageIndex: 0 }
    });
    expect(states.at(-1)).not.toHaveProperty('evictedThrough');
    const projected = proposal!.project([a, b]);
    expect(projected[0]?.content).toContain('view_image({"resourceId":"a"})');
    projection.adoptGc(proposal!.state);
    const released = await projection.prepare(request([a, b]));
    expect(released.messages.map((m) => m.images?.length)).toEqual([0, 1]);
    expect(released.messages[0]?.content).toContain('view_image({"resourceId":"a"})');
    expect(released.messages[1]?.content).not.toContain('Image released');
    expect(projection.historyView([a, b]).map((message) => message.content)).toEqual(
      released.messages.map((message) => message.content)
    );
    expect(a.content).toBe('a');
    expect(a.images).toHaveLength(1);
  });

  it('rejects three available maximum legal images before they can be sent', async () => {
    const { projection, store } = fixture();
    const prepared = await projection.prepare(
      request(['a', 'b', 'c'].map((id) => imageMessage(id)))
    );
    expect(() => assertInlineMediaBudget(projectModelRequest(prepared))).toThrow(
      expect.objectContaining({ code: 'MAR_AGENT_INLINE_MEDIA_LIMIT' })
    );
    expect(store.readResource).toHaveBeenCalledTimes(3);
    expect(projection.hasPendingImages([imageMessage('a')])).toBe(true);
  });

  it('protects recent rollouts and offers a lower-watermark candidate only for text GC', async () => {
    const { projection } = fixture();
    const a = imageMessage('a', 2 * MiB),
      b = imageMessage('b', 2 * MiB);
    await projection.complete(await projection.prepare(request([a, b])));
    expect(await projection.gcCandidate()).toBeUndefined();
    // A failed/uncompleted request does not age the images.
    await projection.prepare(request([a, b]));
    expect(await projection.gcCandidate()).toBeUndefined();
    await projection.complete(await projection.prepare(request([a, b])));
    expect(await projection.gcCandidate()).toMatchObject({
      reason: 'TEXT_GC',
      state: { evictedThrough: { sourceId: 'tool:a' } }
    });
  });

  it('counts compact and failed attempts neither as normal rollout protection', async () => {
    const { store } = fixture();
    const a = imageMessage('a'),
      b = imageMessage('b');
    const values = [
      record('model.context', a, 1),
      record('model.context', b, 2),
      record(
        'resource.window',
        { version: 1, consideredThrough: { sourceId: 'tool:b', imageIndex: 0 } },
        3
      ),
      record('model.attempt', { purpose: 'EXECUTION', state: 'FAILED' }, 4),
      record('model.attempt', { purpose: 'COMPACTION', state: 'SUCCEEDED' }, 5),
      record('model.attempt', { purpose: 'EXECUTION', state: 'SUCCEEDED' }, 6)
    ];
    const reopened = new ResourceInputProjection(false, store, 'session', [a, b], {
      records: values
    });
    expect(await reopened.gcCandidate()).toBeUndefined();
    await reopened.complete(await reopened.prepare(request([a, b])));
    expect((await reopened.gcCandidate())?.reason).toBe('SOFT_LIMIT');
  });

  it('proposes urgent GC without sacrificing fresh images or waiting for protection', async () => {
    const { projection } = fixture();
    const old = imageMessage('old');
    await projection.complete(await projection.prepare(request([old])));
    const candidate = request([old, imageMessage('b'), imageMessage('c')]);
    projection.observe(candidate.messages);
    const proposal = await projection.gcCandidate(candidate);
    expect(proposal?.reason).toBe('HARD_LIMIT');
    const prepared = await projection.prepare(candidate);
    expect(() => assertInlineMediaBudget(projectModelRequest(prepared))).toThrow(
      expect.objectContaining({ code: 'MAR_AGENT_INLINE_MEDIA_LIMIT' })
    );
    projection.adoptGc(proposal!.state);
    const next = await projection.prepare(candidate);
    expect(next.messages.map((m) => m.images?.length)).toEqual([0, 1, 1]);
    expect(projection.hasPendingImages([imageMessage('b')])).toBe(true);
  });

  it('does not process uncompleted requests or lose a later steer behind a prepared candidate', async () => {
    const { projection } = fixture();
    const a = imageMessage('a');
    const b = imageMessage('b');
    const candidate = await projection.prepare(request([a]));
    await projection.prepare(request([a, b]));
    await projection.complete(candidate);
    expect(projection.hasPendingImages([a])).toBe(false);
    expect(projection.hasPendingImages([b])).toBe(true);
  });

  it('bounds the default encoded budget, not raw binary bytes', () => {
    expect(INLINE_MEDIA_POLICY).toEqual({
      historicalInlineMediaTrigger: 7 * MiB,
      historicalInlineMediaTarget: 5 * MiB,
      requestInlineMediaHardLimit: 12 * MiB
    });
  });

  it('cold-restores an evicted anchor even when GC removed that source from active messages', async () => {
    const { store } = fixture();
    const a = imageMessage('a'),
      b = imageMessage('b'),
      c = imageMessage('c');
    const records = [
      record('model.context', a, 1),
      record('model.context', b, 2),
      record(
        'resource.window',
        {
          version: 1,
          consideredThrough: { sourceId: 'tool:b', imageIndex: 0 },
          evictedThrough: { sourceId: 'tool:a', imageIndex: 0 }
        },
        3
      ),
      record('model.context', c, 4)
    ];
    const projection = new ResourceInputProjection(false, store, 'session', [b, c], { records });
    expect(projection.hasPendingImages([b])).toBe(false);
    expect(projection.hasPendingImages([c])).toBe(true);
    const prepared = await projection.prepare(request([b, c]));
    expect(prepared.messages.map((m) => m.images?.length)).toEqual([1, 1]);
    expect(projection.checkpoint()).toMatchObject({ consideredThrough: { sourceId: 'tool:b' } });
  });

  it('anchors extension input image cursors to the extension record identity', () => {
    const extension = record('extension.input', { prompt: 'inspect', images: [{}, {}] }, 1);
    const considered = { sourceId: `input:${extension.recordId}`, imageIndex: 1 };
    const records = [
      extension,
      record('resource.window', { version: 1, consideredThrough: considered }, 2)
    ];
    expect(inlineMediaHistory(records).cursors).toEqual([
      { ...considered, imageIndex: 0, rollout: 0 },
      { ...considered, rollout: 0 }
    ]);
    expect(
      inlineMediaGcAnchored(records, hardGc({ ...considered, imageIndex: 0 }, considered))
    ).toBe(true);
    expect(
      inlineMediaGcAnchored(
        records,
        hardGc({ sourceId: 'input:another-record', imageIndex: 0 }, considered)
      )
    ).toBe(false);
  });

  it('anchors an applied deferred input once at its original inputRef', () => {
    const received = record('turn.user', { deferred: true, prompt: 'inspect', images: [{}] }, 1);
    const applied = record(
      'model.context',
      {
        role: 'user',
        content: 'inspect',
        inputRef: received.recordId,
        input: { deferred: true, prompt: 'inspect', images: [{}] }
      },
      2
    );
    const considered = { sourceId: `input:${received.recordId}`, imageIndex: 0 };
    const records = [
      received,
      applied,
      record('resource.window', { version: 1, consideredThrough: considered }, 3)
    ];
    expect(inlineMediaHistory(records).cursors).toEqual([{ ...considered, rollout: 0 }]);
    expect(inlineMediaGcAnchored(records, hardGc(considered, considered))).toBe(true);
    expect(
      inlineMediaGcAnchored(
        records,
        hardGc({ sourceId: `input:${applied.recordId}`, imageIndex: 0 }, considered)
      )
    ).toBe(false);
  });

  it('anchors only the user inputs retained across Compact', () => {
    const prior = record('turn.user', { images: [{}] }, 1);
    const retained: ModelMessage = {
      role: 'user',
      content: 'retained',
      metadata: { recordId: 'retained-input' },
      images: [{ mimeType: 'image/png', resourceId: 'retained', byteSize: 1 }]
    };
    const considered = { sourceId: 'input:retained-input', imageIndex: 0 };
    const records = [
      prior,
      record(
        'compact.completed',
        { inlineMediaState: { version: 1 }, retainedModelContext: [retained] },
        2
      ),
      record('resource.window', { version: 1, consideredThrough: considered }, 3)
    ];
    expect(inlineMediaHistory(records).cursors).toEqual([{ ...considered, rollout: 0 }]);
    expect(inlineMediaGcAnchored(records, hardGc(considered, considered))).toBe(true);
    expect(
      inlineMediaGcAnchored(
        records,
        hardGc({ sourceId: `input:${prior.recordId}`, imageIndex: 0 }, considered)
      )
    ).toBe(false);
  });

  it('rebases Compact to its retained tail without processing pending images', async () => {
    const { projection, store } = fixture();
    const a = imageMessage('a'),
      b = imageMessage('b');
    await projection.complete(await projection.prepare(request([a])));
    projection.observe([b]);
    const checkpoint = projection.checkpoint([b]);
    expect(checkpoint).toEqual({ version: 1 });
    const records = [
      record('compact.completed', { inlineMediaState: checkpoint, retainedModelContext: [b] }, 1)
    ];
    const reopened = new ResourceInputProjection(false, store, 'session', [b], { records });
    expect(reopened.hasPendingImages([b])).toBe(true);
    expect((await reopened.prepare(request([b]))).messages[0]?.images).toHaveLength(1);
  });

  it('keeps Hook omission request-local and protects replacement images as fresh', async () => {
    const { projection, states } = fixture();
    const a = imageMessage('a'),
      b = imageMessage('b');
    const prepared = await projection.prepare(request([]), [], [a, b]);
    await projection.complete(prepared);
    expect(projection.hasPendingImages([a, b])).toBe(false);
    expect(states.at(-1)).not.toHaveProperty('evictedThrough');
    const replacement = { ...a, images: [imageMessage('replacement').images![0]!] };
    const next = await projection.prepare(request([replacement, b]), [], [a, b]);
    expect(next.messages.map((m) => m.images?.length)).toEqual([1, 1]);
  });

  it('remaps Code Mode observation image indices and puts release notices on matching observations', async () => {
    const { projection } = fixture();
    const encoded = 'x'.repeat(3 * MiB - 1024);
    const code = {
      ...imageMessage('code'),
      images: ['a', 'b', 'c'].map((resourceId) => ({
        mimeType: 'image/png',
        resourceId,
        dataBase64: encoded
      })),
      observations: [
        {
          type: 'tool_result' as const,
          id: 'result',
          source: { callId: 'inner', toolName: 'read', input: {} },
          outcome: 'completed' as const,
          result: { content: 'result', imageIndices: [0, 2] }
        },
        {
          type: 'value' as const,
          id: 'value',
          format: 'image' as const,
          value: 'value',
          imageIndices: [1, 2]
        }
      ]
    };
    await projection.complete(await projection.prepare(request([code])));
    await projection.complete(await projection.prepare(request([code])));
    const proposal = await projection.gcCandidate();
    expect(proposal?.state.evictedThrough).toEqual({ sourceId: 'tool:code', imageIndex: 1 });
    projection.adoptGc(proposal!.state);

    const projected = (await projection.prepare(request([code]))).messages[0]!;
    expect(projected.images?.map((image) => image.resourceId)).toEqual(['c']);
    expect(projected.observations?.[0]).toMatchObject({
      result: {
        imageIndices: [0],
        content: expect.stringContaining('view_image({"resourceId":"a"})')
      }
    });
    expect(projected.observations?.[1]).toMatchObject({
      imageIndices: [0],
      value: expect.stringContaining('view_image({"resourceId":"b"})')
    });
  });

  it('keeps original image positions across successive partial Code Mode evictions', async () => {
    const { projection, store } = fixture();
    const encoded = Buffer.alloc(512 * 1024).toString('base64');
    const message = (callId: string, count: number): ModelMessage => ({
      role: 'tool',
      callId,
      content: 'images',
      images: Array.from({ length: count }, (_, index) => ({
        mimeType: 'image/png',
        resourceId: `${callId}-${index}`,
        dataBase64: encoded
      })),
      observations: [
        {
          type: 'value',
          id: callId,
          format: 'image',
          value: 'images',
          imageIndices: Array.from({ length: count }, (_, index) => index)
        }
      ]
    });
    const original = message('original', 10);
    await projection.complete(await projection.prepare(request([original])));
    await projection.complete(await projection.prepare(request([original])));
    const first = (await projection.gcCandidate())!;
    expect(first.state.evictedThrough).toEqual({ sourceId: 'tool:original', imageIndex: 2 });
    projection.adoptGc(first.state);

    const later = message('later', 5);
    await projection.complete(await projection.prepare(request([original, later])));
    const second = (await projection.gcCandidate())!;
    expect(second.state.evictedThrough).toEqual({ sourceId: 'tool:original', imageIndex: 7 });
    const { images: _images, ...referenceOnly } = original;
    const planned = second.project(projection.historyView([referenceOnly, later]));
    expect(planned[0]?.images?.map((image) => image.resourceId)).toEqual([
      'original-8',
      'original-9'
    ]);
    expect(planned[0]?.observations?.[0]).toMatchObject({ imageIndices: [0, 1] });
    projection.adoptGc(second.state);
    const prepared = await projection.prepare(request([original, later]));
    expect(planned.map((entry) => entry.content)).toEqual(
      prepared.messages.map((entry) => entry.content)
    );
    expect(planned[0]?.observations).toEqual(prepared.messages[0]?.observations);
    expect(store.readResource).not.toHaveBeenCalled();
  });

  it('remaps only input cursor identities when forking and retains tool-call identities', () => {
    const state = {
      version: 1,
      consideredThrough: { sourceId: 'tool:kept', imageIndex: 1 },
      evictedThrough: { sourceId: 'input:old', imageIndex: 0 }
    };
    expect(
      forkedPayload(
        'resource.window',
        state,
        'old-session',
        'new-session',
        'fork',
        new Map([['old', { recordId: 'new', sequence: 2 }]])
      )
    ).toMatchObject({
      evictedThrough: { sourceId: 'input:new' },
      consideredThrough: { sourceId: 'tool:kept' }
    });
    expect(state.evictedThrough.sourceId).toBe('input:old');
    expect(
      inlineMediaHistory([record('compact.completed', { inlineMediaState: { version: 1 } }, 1)])
        .state
    ).toEqual({ version: 1 });
  });
});
