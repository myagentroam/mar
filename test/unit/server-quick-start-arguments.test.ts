import { describe, expect, it } from 'vitest';
import { parseQuickStartArguments } from '../../mar-server/src/quick-start/arguments.js';

describe('Quick Start arguments', () => {
  it('parses setup choices without converting omitted flags to defaults', () => {
    expect(parseQuickStartArguments(['setup'])).toEqual({ command: 'setup' });
    expect(parseQuickStartArguments(['setup', '--no-node', '--no-searxng'])).toEqual({
      command: 'setup',
      node: false,
      searxng: false
    });
    expect(parseQuickStartArguments(['run', '--config', 'path with spaces/server.json'])).toEqual({
      command: 'run',
      config: 'path with spaces/server.json'
    });
    expect(
      parseQuickStartArguments(['setup', '--reinstall-searxng', '--config', 'custom.json'])
    ).toEqual({
      command: 'setup',
      config: 'custom.json',
      reinstallSearxng: true
    });
  });

  it('provides help without selecting a setup action', () => {
    expect(parseQuickStartArguments(['--help'])).toEqual({ command: 'help' });
    expect(parseQuickStartArguments(['setup', '--help'])).toEqual({ command: 'help' });
  });

  it.each([
    [],
    ['other'],
    ['run', '--no-node'],
    ['run', '--reinstall-searxng'],
    ['setup', '--unknown'],
    ['setup', '--config'],
    ['setup', '--config', ''],
    ['setup', '--config', 'a', '--config', 'b'],
    ['setup', '--no-node', '--no-node'],
    ['setup', '--reinstall-searxng', '--reinstall-searxng'],
    ['setup', '--reinstall-searxng', '--no-searxng'],
    ['setup', '--no-node', '--reinstall-searxng'],
    ['setup', '--help', '--unknown']
  ])('rejects invalid input before any setup: %j', (...args) => {
    expect(() => parseQuickStartArguments(args)).toThrow();
  });
});
