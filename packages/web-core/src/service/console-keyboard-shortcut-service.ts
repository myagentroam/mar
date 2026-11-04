export type ConsoleShortcutResult = 'HANDLED' | 'IGNORED';
export type ConsoleShortcutScope =
  'global' | 'workspace' | 'pane' | 'file-preview' | 'terminal' | 'overlay';

export interface ConsoleShortcutKey {
  readonly key: string;
  readonly code?: string;
  readonly ctrl?: boolean;
  readonly alt?: boolean;
  readonly meta?: boolean;
  readonly shift?: boolean;
}

export interface ConsoleShortcutBinding {
  readonly command: string;
  readonly priority: number;
  readonly scope: ConsoleShortcutScope;
  readonly owner?: () => Element | undefined;
  /** The containing surface when events can originate in a same-origin frame. */
  readonly modalOwner?: () => Element | undefined;
  readonly allowedInBlockedScopes?: readonly ConsoleShortcutScope[];
  readonly keys: readonly ConsoleShortcutKey[];
  readonly when: (event: KeyboardEvent) => boolean;
  readonly execute: (event: KeyboardEvent) => ConsoleShortcutResult;
}

export interface ConsoleShortcutRegion {
  readonly scope: ConsoleShortcutScope;
  readonly root: () => Element | undefined;
  readonly blocksOtherScopes: boolean;
}

export function invokeConsoleShortcut(
  binding: ConsoleShortcutBinding,
  event: KeyboardEvent
): ConsoleShortcutResult {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return 'IGNORED';
  if (binding.owner !== undefined) {
    const target = event.target as Node | null;
    if (typeof target?.nodeType !== 'number' || binding.owner()?.contains(target) !== true)
      return 'IGNORED';
  }
  const matches = binding.keys.some(
    (key) =>
      (event.key?.toLowerCase() === key.key.toLowerCase() ||
        (key.code !== undefined && event.code === key.code)) &&
      (event.ctrlKey === true) === (key.ctrl === true) &&
      (event.altKey === true) === (key.alt === true) &&
      (event.metaKey === true) === (key.meta === true) &&
      (event.shiftKey === true) === (key.shift === true)
  );
  return matches && binding.when(event) ? binding.execute(event) : 'IGNORED';
}

export interface ConsoleKeyboardShortcutService {
  register(target: ConsoleShortcutBinding): () => void;
  registerRegion(region: ConsoleShortcutRegion): () => void;
  isWithin(scope: ConsoleShortcutScope, target: EventTarget | null): boolean;
  invoke(binding: ConsoleShortcutBinding, event: KeyboardEvent): ConsoleShortcutResult;
  handle(event: KeyboardEvent, scope?: ConsoleShortcutScope): void;
}

export function createConsoleKeyboardShortcutService(): ConsoleKeyboardShortcutService {
  const targets = new Set<ConsoleShortcutBinding>();
  const regions = new Set<ConsoleShortcutRegion>();

  function register(target: ConsoleShortcutBinding): () => void {
    targets.add(target);
    return () => targets.delete(target);
  }

  function registerRegion(region: ConsoleShortcutRegion): () => void {
    regions.add(region);
    return () => regions.delete(region);
  }

  function isWithin(scope: ConsoleShortcutScope, target: EventTarget | null): boolean {
    const node = target as Node | null;
    return (
      typeof node?.nodeType === 'number' &&
      [...regions].some(
        (region) => region.scope === scope && region.root()?.contains(node) === true
      )
    );
  }

  function invoke(binding: ConsoleShortcutBinding, event: KeyboardEvent): ConsoleShortcutResult {
    const eventTarget = event.target as Node | null;
    const blockedScopes = [...regions]
      .filter(
        (region) =>
          region.blocksOtherScopes &&
          typeof eventTarget?.nodeType === 'number' &&
          region.root()?.contains(eventTarget)
      )
      .map((region) => region.scope);
    if (
      !blockedScopes.every(
        (blocked) =>
          binding.scope === blocked || binding.allowedInBlockedScopes?.includes(blocked) === true
      )
    )
      return 'IGNORED';
    if (typeof document !== 'undefined' && typeof document.querySelectorAll === 'function') {
      const dialogs = [
        ...document.querySelectorAll('[role="dialog"][aria-modal="true"], dialog[open]')
      ].filter((dialog) => dialog.getClientRects().length > 0);
      const zIndex = (element: Element): number => {
        if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function')
          return 0;
        let highest = 0;
        for (
          let current: Element | null = element;
          current !== null;
          current = current.parentElement
        ) {
          const value = Number.parseInt(window.getComputedStyle(current).zIndex, 10);
          if (Number.isFinite(value)) highest = Math.max(highest, value);
        }
        return highest;
      };
      const modal = dialogs.reduce<Element | undefined>(
        (top, dialog) => (top === undefined || zIndex(dialog) >= zIndex(top) ? dialog : top),
        undefined
      );
      if (modal !== undefined) {
        const owner = binding.modalOwner?.() ?? binding.owner?.();
        if (owner === undefined || !modal.contains(owner)) return 'IGNORED';
      }
    }
    return invokeConsoleShortcut(binding, event);
  }

  function handle(event: KeyboardEvent, scope?: ConsoleShortcutScope): void {
    const ordered = [...targets]
      .filter(
        (target) =>
          scope === undefined ||
          target.scope === scope ||
          (target.scope === 'overlay' && target.allowedInBlockedScopes?.includes(scope) === true)
      )
      .sort((left, right) => right.priority - left.priority);
    for (const target of ordered) {
      const result = invoke(target, event);
      if (result !== 'HANDLED') continue;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
  }

  return { register, registerRegion, isWithin, invoke, handle };
}

export const consoleKeyboardShortcutService = createConsoleKeyboardShortcutService();
