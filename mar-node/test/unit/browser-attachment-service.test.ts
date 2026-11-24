import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserAttachmentPrepare, BrowserAttachmentRoute } from '@myagentroam/protocol';
import { BrowserAttachmentService } from '../../src/browser/browser-attachment-service.js';
import { BrowserSessionService } from '../../src/browser/browser-session-service.js';
import type { BrowserTabs } from '../../src/browser/browser-tabs.js';

const scope = { workspaceId: 'work', userId: 1 };
const ice: BrowserAttachmentRoute = {
  type: 'ice',
  transportId: 'transport',
  fingerprint: 'fingerprint'
};
const relay: BrowserAttachmentRoute = { type: 'relay' };

afterEach(() => vi.useRealTimers());

async function fixture(idleMs?: number) {
  const dismiss = vi.fn(async (_present: boolean) => {});
  const tabs = {
    snapshot: () => ({ activeId: undefined, viewVersion: 1, tabs: [] }),
    viewport: { width: 960, height: 600 },
    observe: () => () => {},
    attach: () => dismiss(true),
    detach: () => dismiss(false)
  } as unknown as BrowserTabs;
  const sessions = new BrowserSessionService({
    launch: async () => ({ resource: tabs, close: async () => {} }),
    limit: 1,
    ...(idleMs !== undefined && { idleMs }),
    onCloseFailed: vi.fn()
  });
  const browserId = await sessions.open(scope);
  const service = new BrowserAttachmentService({ sessions, failed: vi.fn() });
  function grant(
    route: BrowserAttachmentRoute,
    overrides: Partial<BrowserAttachmentPrepare> = {}
  ): BrowserAttachmentPrepare {
    const value = {
      ...scope,
      browserId,
      attachmentId: randomUUID(),
      ticket: randomUUID(),
      route,
      sessionId: 'same-session',
      connectionId: 'same-page',
      expiresAt: Date.now() + 10_000,
      ...overrides
    };
    service.prepare(value);
    return value;
  }
  return {
    service,
    sessions,
    browserId,
    grant,
    dismiss,
    close: async () => {
      await service.shutdown();
      await sessions.shutdown();
    }
  };
}

function channel() {
  return { sendControl: vi.fn(), sendFrame: vi.fn(async () => {}), close: vi.fn() };
}

function open(grant: BrowserAttachmentPrepare) {
  return {
    type: 'OPEN' as const,
    attachmentId: grant.attachmentId,
    ticket: grant.ticket,
    rfb: true as const
  };
}

describe('Node Browser attachment admission', () => {
  it.each([ice, relay])('requires an RFB client on either route: %o', async (route) => {
    const f = await fixture();
    try {
      const grant = f.grant(route);
      const link = channel();
      const { rfb: _, ...old } = open(grant);
      await expect(f.service.open(old, route, link)).rejects.toThrow('BROWSER_INVALID_GRANT');
      await f.service.open(open(grant), route, link);
      expect(link.sendControl).toHaveBeenCalledWith({ type: 'ATTACHED', rfb: true });
      expect(link.sendControl).toHaveBeenCalledWith({
        type: 'rfb',
        data: Buffer.from('RFB 003.008\n').toString('base64')
      });
    } finally {
      await f.close();
    }
  });

  it('does not shorten a lease when an older renewal arrives second', async () => {
    const f = await fixture();
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const grant = f.grant(relay, { expiresAt: now + 4_000 });
      expect(f.service.renew(grant.attachmentId, now + 10_000)).toBe(true);
      expect(f.service.renew(grant.attachmentId, now + 6_000)).toBe(true);
      clock.mockReturnValue(now + 7_000);
      const link = channel();
      await f.service.open(open(grant), relay, link);
      expect(link.sendControl).toHaveBeenCalledWith({ type: 'ATTACHED', rfb: true });
    } finally {
      clock.mockRestore();
      await f.close();
    }
  });

  it('keeps a foreground attachment alive without input and expires it when only the lease is renewed', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
    const f = await fixture(15_000);
    try {
      const grant = f.grant(relay);
      const link = channel();
      await f.service.open(open(grant), relay, link);
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(5_000);
        f.service.receive(grant.attachmentId, link, { type: 'presence' });
        expect(f.service.renew(grant.attachmentId, Date.now() + 10_000)).toBe(true);
        expect(f.sessions.lookup(scope)).toBe(f.browserId);
      }
      expect(await f.sessions.open(scope, true)).toBe(f.browserId);

      for (let i = 0; i < 2; i++) {
        await vi.advanceTimersByTimeAsync(5_000);
        expect(f.service.renew(grant.attachmentId, Date.now() + 10_000)).toBe(true);
        f.service.receive(grant.attachmentId, channel(), { type: 'presence' });
      }
      await vi.advanceTimersByTimeAsync(5_000);
      expect(f.sessions.lookup(scope)).toBeUndefined();
      const replacement = await f.sessions.open(scope, true);
      expect(replacement).not.toBe(f.browserId);
      expect(f.sessions.lookup(scope)).toBe(replacement);
    } finally {
      await f.close();
    }
  });

  it('binds one-shot OPEN to the prepared route and keeps a valid grant after an invalid attempt', async () => {
    const f = await fixture();
    try {
      const grant = f.grant(ice);
      const link = channel();
      await expect(f.service.open(open(grant), relay, link)).rejects.toThrow(
        'BROWSER_INVALID_GRANT'
      );
      await expect(
        f.service.open(open(grant), { ...ice, fingerprint: 'other' }, link)
      ).rejects.toThrow('BROWSER_INVALID_GRANT');
      expect(link.sendControl).not.toHaveBeenCalled();
      await f.service.open(open(grant), ice, link);
      expect(link.sendControl).toHaveBeenNthCalledWith(1, { type: 'ATTACHED', rfb: true });
      await expect(f.service.open(open(grant), ice, channel())).rejects.toThrow(
        'BROWSER_INVALID_GRANT'
      );
    } finally {
      await f.close();
    }
  });

  it('supports independent viewers and restricts handoff to the same logical page', async () => {
    const f = await fixture();
    try {
      const first = f.grant(ice);
      const initialLink = channel();
      await f.service.open(open(first), ice, initialLink);
      const other = f.grant(relay, { connectionId: 'another-page' });
      const otherLink = channel();
      await f.service.open(open(other), relay, otherLink);
      expect(otherLink.sendControl).toHaveBeenCalledWith({ type: 'ATTACHED', rfb: true });
      const wrong = f.grant(relay, { replaces: first.attachmentId, connectionId: 'another-page' });
      await expect(f.service.open(open(wrong), relay, channel())).rejects.toThrow(
        'BROWSER_INVALID_GRANT'
      );
      expect(initialLink.close).not.toHaveBeenCalled();
      const next = f.grant(relay, { replaces: first.attachmentId });
      const nextLink = channel();
      const dismissed = Promise.withResolvers<void>();
      f.dismiss.mockImplementationOnce(() => dismissed.promise);
      const switched = f.service.open(open(next), relay, nextLink);
      try {
        await vi.waitFor(() =>
          expect(initialLink.close).toHaveBeenCalledWith('BROWSER_ATTACHMENT_REPLACED')
        );
        expect(nextLink.sendControl).not.toHaveBeenCalled();
      } finally {
        dismissed.resolve();
      }
      await switched;
      expect(otherLink.close).not.toHaveBeenCalled();
      expect(nextLink.sendControl).toHaveBeenNthCalledWith(1, { type: 'ATTACHED', rfb: true });
      expect(f.sessions.lookup(scope)).toBe(f.browserId);
    } finally {
      await f.close();
    }
  });
});
