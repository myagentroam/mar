import { describe, expect, it } from 'vitest';
import {
  formatRelativeSessionActivity,
  shouldAnimateSessionReorder,
  type SessionReorderSnapshot,
  WORKSPACE_SESSION_PAGE_SIZE
} from '../../src/util/session-list';
import {
  sessionActivityDateTime,
  sessionActivityTitle
} from '../../src/util/workbench-presentation';
import { restorableWorkspaceSessions } from '../../src/service/workbench-presentation-state-service';

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

describe('Session activity reorder motion', () => {
  const first = { key: 'first', lastActivityAt: 200, pin: null };
  const second = { key: 'second', lastActivityAt: 100, pin: null };
  const before: SessionReorderSnapshot = {
    context: 'node/workspace:',
    ready: true,
    items: [first, second]
  };
  const after: SessionReorderSnapshot = {
    ...before,
    items: [{ ...second, lastActivityAt: 300 }, first]
  };

  it('animates an existing session moving up and its displaced neighbor moving down', () => {
    expect(shouldAnimateSessionReorder(before, after)).toBe(true);
    expect(
      shouldAnimateSessionReorder(after, {
        ...before,
        items: [{ ...first, lastActivityAt: 400 }, after.items[0]!]
      })
    ).toBe(true);
  });

  it('does not animate initial load, additions, deletions or replaced membership', () => {
    expect(shouldAnimateSessionReorder(undefined, after)).toBe(false);
    for (const items of [
      [],
      [first],
      [...after.items, { ...first, key: 'third' }],
      [{ ...second, key: 'replacement', lastActivityAt: 300 }, first]
    ]) {
      expect(shouldAnimateSessionReorder(before, { ...after, items })).toBe(false);
    }
  });

  it('does not animate filtering, context switches or either side of a loading update', () => {
    expect(shouldAnimateSessionReorder(before, { ...after, context: 'node/other:' })).toBe(false);
    expect(shouldAnimateSessionReorder(before, { ...after, context: 'node/workspace:query' })).toBe(
      false
    );
    expect(shouldAnimateSessionReorder(before, { ...after, ready: false })).toBe(false);
    expect(shouldAnimateSessionReorder({ ...before, ready: false }, after)).toBe(false);
  });

  it('does not animate manual pin changes even if activity advances in the same update', () => {
    expect(
      shouldAnimateSessionReorder(before, {
        ...after,
        items: [{ ...second, pin: 0, lastActivityAt: 300 }, first]
      })
    ).toBe(false);
    expect(
      shouldAnimateSessionReorder(
        {
          ...before,
          items: [
            { ...first, pin: 0 },
            { ...second, pin: 1 }
          ]
        },
        {
          ...after,
          items: [
            { ...second, pin: 0, lastActivityAt: 300 },
            { ...first, pin: 1 }
          ]
        }
      )
    ).toBe(false);
  });

  it('requires both a changed order and a known activity time advancing', () => {
    expect(
      shouldAnimateSessionReorder(before, {
        ...before,
        items: [first, { ...second, lastActivityAt: 150 }]
      })
    ).toBe(false);
    expect(shouldAnimateSessionReorder(before, { ...after, items: [second, first] })).toBe(false);
    expect(
      shouldAnimateSessionReorder(before, {
        ...after,
        items: [{ ...second, lastActivityAt: 50 }, first]
      })
    ).toBe(false);
    for (const lastActivityAt of [undefined, 0, Number.NaN]) {
      expect(
        shouldAnimateSessionReorder(
          { ...before, items: [first, { ...second, lastActivityAt }] },
          after
        )
      ).toBe(false);
    }
  });
});
