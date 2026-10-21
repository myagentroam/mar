import { describe, expect, it } from 'vitest';
import {
  formatRelativeSessionActivity,
  WORKSPACE_SESSION_PAGE_SIZE
} from '../../src/util/session-list';
import {
  sessionActivityDateTime,
  sessionActivityTitle
} from '../../src/util/workbench-presentation';
import { restorableWorkspaceSessions } from '../../src/service/WorkbenchPresentationStateService';

describe('Web session list', () => {
  it('shows thirty sessions per page by default', () => {
    expect(WORKSPACE_SESSION_PAGE_SIZE).toBe(30);
  });

  it('formats last-activity time as a compact relative value', () => {
    const now = 1_800_000_000_000;
    expect(formatRelativeSessionActivity(now - 10_000, now)).toBe('<1m');
    expect(formatRelativeSessionActivity(now - 5 * 60_000, now)).toBe('>5m');
    expect(formatRelativeSessionActivity(now - 2 * 60 * 60_000, now)).toBe('>2h');
    expect(formatRelativeSessionActivity(now - 3 * 24 * 60 * 60_000, now)).toBe('>3d');
    expect(formatRelativeSessionActivity(undefined, now)).toBe('—');
    expect(formatRelativeSessionActivity(0, now)).toBe('—');
    expect(formatRelativeSessionActivity(-1, now)).toBe('—');
  });

  it('shows only the four Runner sessions with native identities in Chats', () => {
    const runners = ['codex', 'claude-code', 'opencode', 'mar-agent'] as const;
    const sessions = runners.flatMap((runner) => [
      {
        id: `bootstrap-${runner}`,
        workspaceId: 'workspace-1',
        runner,
        externalSessionId: null
      },
      {
        id: `native-${runner}`,
        workspaceId: 'workspace-1',
        runner,
        externalSessionId: `native-${runner}`
      }
    ]);

    expect(
      restorableWorkspaceSessions(sessions, 'workspace-1').map((session) => session.id)
    ).toEqual(runners.map((runner) => `native-${runner}`));
    expect(restorableWorkspaceSessions(sessions, undefined)).toEqual([]);
  });

  it('does not create a Unix epoch tooltip or datetime for an unknown activity time', () => {
    const format = (value: number) => `formatted:${value}`;
    for (const lastActivityAt of [0, -1, Number.NaN]) {
      const session = { externalDiscovered: true, lastActivityAt } as never;
      expect(sessionActivityTitle(session, format)).toBeUndefined();
      expect(sessionActivityDateTime(session)).toBeUndefined();
    }
  });
});
