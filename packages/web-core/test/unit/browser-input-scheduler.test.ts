import { describe, expect, it, vi } from 'vitest';
import type { BrowserPageInput } from '@myagentroam/protocol';
import { BrowserInputScheduler } from '../../src/service/browser-input-scheduler.js';

const point = (x: number, y = 2, viewVersion = 1) => ({ x, y, viewVersion });

function setup() {
  let next = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  const sent: BrowserPageInput[] = [];
  const send = vi.fn((action: BrowserPageInput) => (sent.push(action), true));
  const scheduler = new BrowserInputScheduler(send, {
    request(callback) {
      callbacks.set(++next, callback);
      return next;
    },
    cancel: (id) => {
      callbacks.delete(id);
    }
  });
  function tick() {
    const batch = [...callbacks.values()];
    callbacks.clear();
    for (const callback of batch) callback(0);
  }
  return { scheduler, sent, send, tick };
}

describe('Browser input scheduling', () => {
  it('sends leading movement right away and flushes the latest touch point before release', () => {
    const { scheduler, sent, tick } = setup();
    const touch = (phase: 'start' | 'move' | 'end', x: number) =>
      ({ type: 'touch', phase, ...point(x) }) as const;
    scheduler.send(touch('start', 1));
    scheduler.send(touch('move', 2));
    for (let x = 3; x <= 100; x++) scheduler.send(touch('move', x));
    expect(sent).toEqual([touch('start', 1), touch('move', 2)]);
    scheduler.send(touch('end', 100));
    tick();
    expect(sent).toEqual([
      touch('start', 1),
      touch('move', 2),
      touch('move', 100),
      touch('end', 100)
    ]);
  });

  it('aims every wheel batch and preserves delta, reversing direction and changing targets in order', () => {
    const { scheduler, sent, tick } = setup();
    const wheel = (x: number, y: number) => ({ type: 'wheel', viewVersion: 1, x, y }) as const;
    scheduler.wheel(point(5), 0, 4);
    scheduler.wheel(point(5), 3, 8);
    scheduler.wheel(point(5), 0, 10);
    scheduler.wheel(point(5), 0, -3);
    scheduler.wheel(point(6), 0, -6);
    tick();
    expect(sent).toEqual([
      { type: 'move', ...point(5) },
      wheel(0, 4),
      wheel(3, 18),
      wheel(0, -3),
      { type: 'move', ...point(6) },
      wheel(0, -6)
    ]);
  });

  it('discards an old pending movement instead of leaking it into a new view', () => {
    const { scheduler, sent, tick } = setup();
    scheduler.send({ type: 'move', ...point(1) });
    scheduler.send({ type: 'move', ...point(2) });
    scheduler.reset();
    scheduler.send({ type: 'button', edge: 'down', button: 'left', ...point(3, 2, 2) });
    tick();
    expect(sent).toEqual([
      { type: 'move', ...point(1) },
      { type: 'button', edge: 'down', button: 'left', ...point(3, 2, 2) }
    ]);
  });
});
