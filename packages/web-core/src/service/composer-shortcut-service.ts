import { consoleKeyboardShortcutService } from './console-keyboard-shortcut-service.js';
import { composerSendKeys, composerStopKeys } from './console-shortcut-keys.js';

/** Product commands shared by each independently targeted composer instance. */
export function registerComposerShortcuts(options: {
  readonly owner: () => Element | undefined;
  readonly canSend: () => boolean;
  readonly canReplace: () => boolean;
  readonly canStop: () => boolean;
  readonly send: (replace: boolean) => void;
  readonly stop: () => void;
}): () => void {
  const unregister = [
    consoleKeyboardShortcutService.registerRegion({
      scope: 'pane',
      root: options.owner,
      blocksOtherScopes: false
    }),
    consoleKeyboardShortcutService.register({
      command: 'composer.send',
      scope: 'pane',
      priority: 100,
      owner: options.owner,
      keys: composerSendKeys,
      when: options.canSend,
      execute: (event) => {
        options.send(event.ctrlKey && options.canReplace());
        return 'HANDLED';
      }
    }),
    consoleKeyboardShortcutService.register({
      command: 'composer.stop',
      scope: 'pane',
      priority: 100,
      owner: options.owner,
      keys: composerStopKeys,
      when: options.canStop,
      execute: () => {
        options.stop();
        return 'HANDLED';
      }
    })
  ];
  return () => {
    for (const release of unregister) release();
  };
}
