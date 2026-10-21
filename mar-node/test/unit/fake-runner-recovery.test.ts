import { describe, expect, it, vi } from 'vitest';
import { FakeRunner } from '../../src/fake-runner.js';
import { terminateProcessTree } from '../../src/process-tree.js';

describe('T006 Fake Runner and reliable buffering', () => {
  it('emits scripted text, tool, and approval events, then succeeds; each approval is decided once', async () => {
    const runner = new FakeRunner(() => 100);
    const events: string[] = [];
    const pending = runner.start(
      'r1',
      [
        { type: 'text', text: 'hello' },
        { type: 'tool', name: 'read' },
        { type: 'approval', id: 'a1' },
        { type: 'success' }
      ],
      {
        event: (type, _payload, terminal) => events.push(`${type}:${terminal ?? ''}`),
        approval: (id) => runner.decide('r1', id, 'APPROVED'),
        disconnect: () => events.push('disconnect')
      }
    );
    await pending;
    expect(events).toEqual([
      'run.started:STARTING',
      'run.running:RUNNING',
      'text:',
      'tool:',
      'approval.approved:',
      'run.succeeded:SUCCEEDED'
    ]);
    expect(runner.decide('r1', 'a1', 'APPROVED')).toBe(false);
  });

  it('distinguishes interrupt from cancel for long runs and replays events in order before ACK', async () => {
    const runner = new FakeRunner();
    const terminal: string[] = [];
    const first = runner.start('interrupt', [{ type: 'long-running' }], {
      event: (_type, _payload, state) => {
        if (state === 'INTERRUPTED' || state === 'CANCELLED') terminal.push(state);
      },
      approval: () => undefined,
      disconnect: () => undefined
    });
    expect(runner.interrupt('interrupt')).toBe(true);
    await first;
    const second = runner.start('cancel', [{ type: 'long-running' }], {
      event: (_type, _payload, state) => {
        if (state === 'INTERRUPTED' || state === 'CANCELLED') terminal.push(state);
      },
      approval: () => undefined,
      disconnect: () => undefined
    });
    expect(runner.cancel('cancel')).toBe(true);
    await second;
    expect(terminal).toEqual(['INTERRUPTED', 'CANCELLED']);

    const approvalRunner = new FakeRunner();
    const approvalTerminal: string[] = [];
    const approvalPending = approvalRunner.start(
      'cancel-approval',
      [{ type: 'approval', id: 'approval' }, { type: 'success' }],
      {
        event: (_type, _payload, state) => {
          if (state === 'CANCELLED') approvalTerminal.push(state);
        },
        approval: () => undefined,
        disconnect: () => undefined
      }
    );
    expect(approvalRunner.cancel('cancel-approval')).toBe(true);
    await approvalPending;
    expect(approvalTerminal).toEqual(['CANCELLED']);
  });

  it('uses process-group cleanup on Linux and taskkill-tree cleanup on Windows', async () => {
    const kill = vi.fn(() => true);
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    await terminateProcessTree({ pid: 42, kill }, 'linux');
    expect(spy).toHaveBeenCalledWith(-42, 'SIGTERM');
    spy.mockRestore();

    const command = vi.fn(async () => undefined);
    await terminateProcessTree({ pid: 43, kill }, 'win32', command);
    expect(command).toHaveBeenCalledWith('taskkill', ['/pid', '43', '/T', '/F'], {
      windowsHide: true
    });
  });
});
