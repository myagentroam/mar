import { describe, expect, it } from 'vitest';
import { ResponsesTextProjection } from '../../src/model/responses-event-projection.js';

describe('Responses attempt text projection', () => {
  it('defers completion until phase is known and emits it once', () => {
    const projection = new ResponsesTextProjection();
    expect(
      projection.project({ item_id: 'one', delta: 'hi' }, 'response.output_text.delta')
    ).toEqual({
      handled: true,
      event: { type: 'text.delta', itemId: 'one', phase: 'commentary', delta: 'hi' }
    });
    expect(projection.project({ item_id: 'one', text: 'hi' }, 'response.output_text.done')).toEqual(
      { handled: true }
    );
    expect(
      projection.project(
        { item: { type: 'message', id: 'one', phase: 'commentary', content: [] } },
        'response.output_item.done'
      )
    ).toEqual({
      handled: true,
      event: { type: 'text.completed', itemId: 'one', phase: 'commentary', text: 'hi' }
    });
    expect(
      projection.project(
        { item: { type: 'message', id: 'one', phase: 'commentary', content: [{ text: 'hi' }] } },
        'response.output_item.done'
      )
    ).toEqual({ handled: true });
    expect([...projection.finish()]).toEqual([]);
  });

  it('flushes unresolved texts in source order and keeps retries independent', () => {
    const first = new ResponsesTextProjection();
    first.project({ item_id: 'a', text: 'first' }, 'response.output_text.done');
    first.project({ item_id: 'b', text: 'second' }, 'response.output_text.done');
    expect([...first.finish()]).toEqual([
      { type: 'text.completed', itemId: 'a', phase: 'final_answer', text: 'first' },
      { type: 'text.completed', itemId: 'b', phase: 'final_answer', text: 'second' }
    ]);
    expect([...first.finish()]).toEqual([]);
    const retry = new ResponsesTextProjection();
    expect(
      retry.project(
        { item: { type: 'message', id: 'a', phase: 'commentary' } },
        'response.output_item.added'
      )
    ).toEqual({ handled: true });
    expect(retry.project({ item_id: 'a', text: 'retry' }, 'response.output_text.done')).toEqual({
      handled: true,
      event: { type: 'text.completed', itemId: 'a', phase: 'commentary', text: 'retry' }
    });
  });

  it('passes through unrelated events and preserves the fallback id for a message', () => {
    const projection = new ResponsesTextProjection();
    expect(
      projection.project(
        { item: { type: 'function_call', id: 'call' } },
        'response.output_item.done'
      )
    ).toEqual({ handled: false });
    expect(
      projection.project(
        { item: { type: 'message', content: [{ type: 'output_text', text: 'no id' }] } },
        'response.output_item.done'
      )
    ).toEqual({
      handled: true,
      event: { type: 'text.completed', itemId: 'text', phase: 'final_answer', text: 'no id' }
    });
    expect([...projection.finish()]).toEqual([]);
  });
});
