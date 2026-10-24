import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActiveNodeTransportService } from '../../src/service/active-node-transport-service.js';

describe('Active Node transport service', () => {
  afterEach(() => vi.useRealTimers());

  it('keeps the current Node active and retains the previous Node for the configured lease', () => {
    vi.useFakeTimers();
    const activate = vi.fn();
    const release = vi.fn();
    const service = createActiveNodeTransportService({
      activate,
      release,
      activeTtlMs: 30 * 60_000
    });

    service.select('node-1');
    vi.advanceTimersByTime(60 * 60_000);
    expect(service.isActive('node-1')).toBe(true);

    service.select('node-2');
    vi.advanceTimersByTime(29 * 60_000);
    expect(service.isActive('node-1')).toBe(true);
    expect(release).not.toHaveBeenCalled();

    vi.advanceTimersByTime(60_000);
    expect(service.isActive('node-1')).toBe(false);
    expect(service.isActive('node-2')).toBe(true);
    expect(release).toHaveBeenCalledWith('node-1');
    expect(activate).toHaveBeenCalledWith('node-2');
    service.clear();
  });

  it('refreshes a Node lease when it is selected again', () => {
    vi.useFakeTimers();
    const release = vi.fn();
    const service = createActiveNodeTransportService({
      activate: vi.fn(),
      release,
      activeTtlMs: 30 * 60_000
    });

    service.select('node-1');
    service.select('node-2');
    vi.advanceTimersByTime(20 * 60_000);
    service.select('node-1');
    service.select('node-2');
    vi.advanceTimersByTime(20 * 60_000);

    expect(service.isActive('node-1')).toBe(true);
    expect(release).not.toHaveBeenCalledWith('node-1');
    service.clear();
  });

  it('keeps activity in memory only and releases tracked Nodes when cleared', () => {
    const release = vi.fn();
    const service = createActiveNodeTransportService({
      activate: vi.fn(),
      release
    });
    service.select('node-1');
    service.select('node-2');

    service.clear();

    expect(service.activeNodeIds()).toEqual([]);
    expect(release).toHaveBeenCalledWith('node-1');
    expect(release).toHaveBeenCalledWith('node-2');
  });
});
