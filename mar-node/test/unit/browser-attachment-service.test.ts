import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
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

async function fixture() {
  const dismiss = vi.fn(async (_present: boolean) => {});
  const tabs = {
    snapshot: () => ({ activeId: undefined, viewVersion: 1, tabs: [] }),
    observe: () => () => {},
    presentDialogs: dismiss
  } as unknown as BrowserTabs;
  const sessions = new BrowserSessionService({
    launch: async () => ({ resource: tabs, close: async () => {} }),
    limit: 1,
    onCloseFailed: vi.fn()
  });
  const browserId = await sessions.open(scope);
  const service = new BrowserAttachmentService({
    sessions,
    encoder: async () => ({ encode: vi.fn(), close: async () => {} }),
    failed: vi.fn()
  });
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
  return { type: 'OPEN' as const, attachmentId: grant.attachmentId, ticket: grant.ticket };
}

describe('Node Browser attachment admission', () => {
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
      expect(link.sendControl).toHaveBeenCalledWith({ type: 'ATTACHED' });
    } finally {
      clock.mockRestore();
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
      expect(link.sendControl).toHaveBeenNthCalledWith(1, { type: 'ATTACHED' });
      await expect(f.service.open(open(grant), ice, channel())).rejects.toThrow(
        'BROWSER_INVALID_GRANT'
      );
    } finally {
      await f.close();
    }
  });

  it('keeps the same browser during handoff, and does not grant another page its writer', async () => {
    const f = await fixture();
    try {
      const first = f.grant(ice);
      const initialLink = channel();
      await f.service.open(open(first), ice, initialLink);
      const wrong = f.grant(relay, { replaces: first.attachmentId, connectionId: 'another-page' });
      await expect(f.service.open(open(wrong), relay, channel())).rejects.toThrow(
        'BROWSER_ATTACHMENT_BUSY'
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
      expect(nextLink.sendControl).toHaveBeenNthCalledWith(1, { type: 'ATTACHED' });
      expect(f.sessions.lookup(scope)).toBe(f.browserId);
    } finally {
      await f.close();
    }
  });
});
