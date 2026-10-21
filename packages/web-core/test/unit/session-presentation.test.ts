import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { Workspace } from '../../src/model/workbench.js';
import { sessionPresentationZhCN } from '../../src/i18n/session-presentation.zh-CN.js';
import { localePreferenceService } from '../../src/service/LocalePreferenceService.js';
import {
  absoluteMessageTime,
  absoluteSessionTime,
  formatDateTime,
  managementDateTime
} from '../../src/util/time-presentation.js';
import {
  sessionHasNativeIdentity,
  sessionIsDraft,
  sessionTitle,
  sessionActivity,
  sessionActivityLabel,
  runStatusLabel,
  temporarySessionTitle
} from '../../src/util/session-presentation.js';

describe('Public Session Presentation', () => {
  beforeEach(() => localePreferenceService().setLocale('zh-CN'));
  it('uses the fixed numeric date format with seconds in both languages and explicit time zones', () => {
    const value = Date.UTC(2026, 9, 17, 11, 50, 2);
    expect(managementDateTime(value, 'Asia/Shanghai')).toBe('2026-10-17 19:50:02');
    localePreferenceService().setLocale('en-US');
    expect(managementDateTime(value, 'Asia/Shanghai')).toBe('2026-10-17 19:50:02');
    expect(managementDateTime(value, 'UTC')).toBe('2026-10-17 11:50:02');
  });

  it.each(['zh-CN', 'en-US'] as const)(
    'keeps midnight in the 00-hour cycle and pads single-digit fields in %s',
    (locale) => {
      localePreferenceService().setLocale(locale);
      const value = Date.UTC(2026, 0, 2, 0, 3, 4);
      expect(managementDateTime(value, 'UTC')).toBe('2026-01-02 00:03:04');
      expect(managementDateTime(new Date(2026, 0, 2, 0, 3, 4).getTime())).toBe(
        '2026-01-02 00:03:04'
      );
    }
  );

  it('Declares only execution-domain fields for public workspaces and no enterprise ownership', () => {
    expectTypeOf<
      Extract<keyof Workspace, 'ownership' | 'ownerOrganizationId'>
    >().toEqualTypeOf<never>();
  });

  it('Preserves custom titles and unknown activity states while translating fixed display semantics', () => {
    const session = {
      id: 'session-1',
      workspaceId: 'workspace-1',
      runner: 'codex' as const,
      customTitle: '  My demo project  ',
      runnerTitle: 'New session'
    };
    expect(sessionTitle(session)).toBe('My demo project');
    expect(runStatusLabel('FUTURE_STATUS')).toBe('FUTURE_STATUS');
    expect(temporarySessionTitle('  hello \n world  ')).toBe('hello world');
    expect(temporarySessionTitle('x'.repeat(200))).toHaveLength(160);
    expect(sessionActivityLabel(session)).toBe(
      sessionPresentationZhCN.generated.sessionPresentation.ready
    );
    expect(runStatusLabel('RUNNING')).toBe(
      sessionPresentationZhCN.generated.sessionPresentation.running2
    );
    localePreferenceService().setLocale('en-US');
    expect(sessionTitle(session)).toBe('My demo project');
    expect(sessionActivityLabel(session)).toBe('Ready');
    expect(runStatusLabel('RUNNING')).toBe('Running');
  });

  it('Uses the explicit activity when it is present and otherwise presents sessions as idle', () => {
    const session = { id: 's', workspaceId: 'w', runner: 'codex' as const };
    expect(sessionActivity(session)).toBe('IDLE');
    expect(sessionActivity({ ...session, activity: 'MANAGED_ACTIVE' })).toBe('MANAGED_ACTIVE');
    expect(sessionActivity({ ...session, activity: 'IDLE' })).toBe('IDLE');
  });

  it.each(['New Session', 'new session', 'Untitled session'])(
    'Preserves the explicit custom title %s even when it matches a Runner placeholder',
    (customTitle) => {
      for (const locale of ['zh-CN', 'en-US'] as const) {
        localePreferenceService().setLocale(locale);
        expect(
          sessionTitle({
            id: 'custom-placeholder',
            workspaceId: 'workspace-1',
            runner: 'codex',
            customTitle,
            runnerTitle: 'Different native title'
          })
        ).toBe(customTitle);
      }
    }
  );

  it('shares one formatter across management, sessions and messages without per-row Intl allocation', () => {
    expect(managementDateTime).toBe(formatDateTime);
    expect(absoluteSessionTime).toBe(formatDateTime);
    expect(absoluteMessageTime).toBe(formatDateTime);
    const value = new Date(2026, 9, 17, 23, 45, 46).getTime();
    const constructor = vi.spyOn(Intl, 'DateTimeFormat');
    try {
      for (const locale of ['zh-CN', 'en-US'] as const) {
        localePreferenceService().setLocale(locale);
        for (let index = 0; index < 10; index++)
          expect(absoluteSessionTime(value)).toBe('2026-10-17 23:45:46');
      }
      expect(constructor).not.toHaveBeenCalled();
    } finally {
      constructor.mockRestore();
    }
  });

  it('resolves changed system time zones without pinning them, including DST dates', () => {
    const original = process.env.TZ;
    try {
      const winter = Date.UTC(2026, 0, 1, 12);
      const summer = Date.UTC(2026, 6, 1, 12);
      process.env.TZ = 'America/New_York';
      expect(absoluteSessionTime(winter)).toBe('2026-01-01 07:00:00');
      expect(absoluteSessionTime(summer)).toBe('2026-07-01 08:00:00');
      process.env.TZ = 'Asia/Shanghai';
      expect(absoluteSessionTime(winter)).toBe('2026-01-01 20:00:00');
      expect(absoluteSessionTime(summer)).toBe('2026-07-01 20:00:00');
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
    expect(managementDateTime(Date.UTC(2026, 0, 1, 12), 'America/New_York')).toBe(
      '2026-01-01 07:00:00'
    );
    expect(managementDateTime(Date.UTC(2026, 6, 1, 12), 'America/New_York')).toBe(
      '2026-07-01 08:00:00'
    );
  });

  it('Localizes new-session default titles and does not treat draft IDs as real sessions', () => {
    expect(
      sessionIsDraft({ id: 'draft:session-1', workspaceId: 'workspace-1', runner: 'codex' })
    ).toBe(true);
    for (const runner of ['codex', 'claude-code', 'opencode', 'mar-agent'] as const) {
      expect(
        sessionHasNativeIdentity({
          id: `bootstrap-${runner}`,
          workspaceId: 'workspace-1',
          runner,
          externalSessionId: null
        })
      ).toBe(false);
      expect(
        sessionIsDraft({
          id: `bootstrap-${runner}`,
          workspaceId: 'workspace-1',
          runner,
          externalSessionId: null
        })
      ).toBe(true);
      expect(
        sessionHasNativeIdentity({
          id: `native-${runner}`,
          workspaceId: 'workspace-1',
          runner,
          externalSessionId: `native-${runner}`
        })
      ).toBe(true);
    }
    expect(
      sessionTitle({
        id: 'session-1',
        workspaceId: 'workspace-1',
        runner: 'mar-agent',
        runnerTitle: 'New session'
      })
    ).toBe(sessionPresentationZhCN.generated.sessionPresentation.newSession);
    localePreferenceService().setLocale('en-US');
    expect(
      sessionTitle({
        id: 'session-1',
        workspaceId: 'workspace-1',
        runner: 'mar-agent',
        runnerTitle: 'New session'
      })
    ).toBe('New Session');
  });
});
