export type ConsoleShortcutResult = 'HANDLED' | 'IGNORED';

export interface ConsoleShortcutTarget {
  readonly priority: number;
  handle(event: KeyboardEvent): ConsoleShortcutResult;
}

export interface ConsoleKeyboardShortcutService {
  register(target: ConsoleShortcutTarget): () => void;
  handle(event: KeyboardEvent): void;
}

export function createConsoleKeyboardShortcutService(): ConsoleKeyboardShortcutService {
  const targets = new Set<ConsoleShortcutTarget>();

  function register(target: ConsoleShortcutTarget): () => void {
    targets.add(target);
    return () => targets.delete(target);
  }

  function handle(event: KeyboardEvent): void {
    const ordered = [...targets].sort((left, right) => right.priority - left.priority);
    for (const target of ordered) {
      if (target.handle(event) !== 'HANDLED') continue;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
  }

  return { register, handle };
}

export const consoleKeyboardShortcutService = createConsoleKeyboardShortcutService();
