/** Parse the local deployment CLI before touching configuration or components. */
export type QuickStartArguments =
  | { readonly command: 'help' }
  | {
      readonly command: 'setup' | 'run';
      readonly config?: string;
      readonly node?: false;
      readonly searxng?: false;
    };

export function parseQuickStartArguments(args: readonly string[]): QuickStartArguments {
  if (args.length === 1 && args[0] === '--help') return { command: 'help' };
  const command = args[0];
  if (command !== 'setup' && command !== 'run') throw new Error('Invalid command');

  let config: string | undefined;
  let node: false | undefined;
  let searxng: false | undefined;
  let help = false;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--config' && config === undefined) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error('Missing configuration path');
      config = value;
    } else if (arg === '--no-node' && command === 'setup' && node === undefined) {
      node = false;
    } else if (arg === '--no-searxng' && command === 'setup' && searxng === undefined) {
      searxng = false;
    } else if (arg === '--help' && !help) {
      help = true;
    } else {
      throw new Error('Invalid argument');
    }
  }
  if (help) return { command: 'help' };
  return {
    command,
    ...(config === undefined ? {} : { config }),
    ...(node === undefined ? {} : { node }),
    ...(searxng === undefined ? {} : { searxng })
  };
}
