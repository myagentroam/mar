import { describe, expect, it, vi } from 'vitest';
import type { NodeDatabase } from '../../src/database.js';
import type { TerminalManager } from '../../src/terminal.js';
import { TerminalService } from '../../src/service/terminal-service.js';

describe('Personal Git terminal ownership', () => {
  it('filters missing and foreign actors and refuses foreign attachment or closure', async () => {
    const terminal = { id: 'personal', state: 'RUNNING' };
    const command = { id: 'command', state: 'RUNNING' };
    const shared = { id: 'shared', state: 'RUNNING' };
    const manager = {
      onSummary: vi.fn(),
      open: vi.fn(() => terminal),
      openCommand: vi.fn(() => command),
      close: vi.fn(async () => terminal),
      authorizeAttach: vi.fn(() => ({ terminalId: terminal.id })),
      get: vi.fn(() => terminal)
    };
    const terminals = [terminal, shared, command];
    const database = { listTerminalSessions: () => terminals };
    const operations = new TerminalService(
      () => database as unknown as NodeDatabase,
      manager as unknown as TerminalManager,
      () => () => undefined
    ).operations();
    operations['terminal.open']!({
      __requestUserId: 7,
      secretEnvironment: { MAR_GIT_TOKEN: 'test-capability' }
    });
    expect(operations['terminal.list']!(undefined)).toEqual({ terminals: [shared, command] });
    expect(operations['terminal.list']!({ __requestUserId: 8 })).toEqual({
      terminals: [shared, command]
    });
    expect(operations['terminal.list']!({ __requestUserId: 7 })).toEqual({
      terminals: [terminal, shared, command]
    });
    expect(() =>
      operations['terminal.attach.authorize']!({
        terminalId: terminal.id,
        __requestUserId: 8
      })
    ).toThrow('TERMINAL_GIT_OWNER_REQUIRED');
    await expect(
      operations['terminal.close']!({
        terminalId: terminal.id,
        __requestUserId: 8
      })
    ).rejects.toThrow('TERMINAL_GIT_OWNER_REQUIRED');
    expect(manager.authorizeAttach).not.toHaveBeenCalled();
    expect(manager.close).not.toHaveBeenCalled();
    operations['terminal.command.open']!({
      __requestUserId: 7,
      command: 'echo okay',
      secretEnvironment: {}
    });
    expect(manager.openCommand).toHaveBeenCalledWith(expect.any(Object), 'echo okay', false);
    expect(operations['terminal.list']!({ __requestUserId: 8 })).toEqual({ terminals: [shared] });
    expect(() =>
      operations['terminal.attach.authorize']!({ terminalId: command.id, __requestUserId: 8 })
    ).toThrow('TERMINAL_OWNER_REQUIRED');
  });
});
