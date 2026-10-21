import { vi } from 'vitest';

export function installPerformanceObserver(
  options: { supportedEntryTypes?: string[]; failure?: 'constructor' | 'observe' } = {}
) {
  const callbacks = new Map<string, (entries: PerformanceEntry[]) => void>();
  const disconnect = vi.fn();
  const observe = vi.fn();
  class FakePerformanceObserver {
    static supportedEntryTypes = options.supportedEntryTypes ?? ['longtask', 'event'];
    constructor(private readonly callback: (list: { getEntries(): PerformanceEntry[] }) => void) {
      if (options.failure === 'constructor') throw new Error('Observer construction failed');
    }
    observe(config: { entryTypes?: string[]; type?: string }): void {
      observe(config);
      if (options.failure === 'observe' && config.entryTypes?.includes('longtask'))
        throw new Error('Long task observation failed');
      const type = config.type ?? config.entryTypes?.[0];
      if (type !== undefined)
        callbacks.set(type, (entries) => this.callback({ getEntries: () => entries }));
    }
    disconnect = disconnect;
  }
  vi.stubGlobal('PerformanceObserver', FakePerformanceObserver);
  return { callbacks, observe, disconnect };
}
