import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { classifyAuditEvent } from '../../ee/web/src/util/audit-presentation.js';
import { enUS as en } from '../../ee/web/src/i18n/messages.en-US.js';
import { zhCN as zh } from '../../ee/web/src/i18n/messages.zh-CN.js';
import {
  MANAGEMENT_PAGE_SIZE,
  createManagementPaginationService,
  managementPageItems
} from '../../ee/web/src/service/management-pagination-service';

describe('management pagination', () => {
  const items = Array.from({ length: 45 }, (_, index) => index + 1);
  it('desktop returns one 20-item page', () => {
    expect(MANAGEMENT_PAGE_SIZE).toBe(20);
    expect(
      managementPageItems(items, {
        mobileViewport: ref(false),
        page: ref(2),
        mobileVisibleCount: ref(MANAGEMENT_PAGE_SIZE)
      })
    ).toEqual(items.slice(MANAGEMENT_PAGE_SIZE, MANAGEMENT_PAGE_SIZE * 2));
  });

  it('mobile returns the accumulated load-more window', () => {
    expect(
      managementPageItems(items, {
        mobileViewport: ref(true),
        page: ref(1),
        mobileVisibleCount: ref(MANAGEMENT_PAGE_SIZE * 2)
      })
    ).toEqual(items.slice(0, MANAGEMENT_PAGE_SIZE * 2));
  });

  it('preserves the current page after reload and reconciles when the last page disappears', () => {
    vi.stubGlobal('window', {
      matchMedia: vi.fn(() => ({ matches: false }))
    });
    try {
      const pagination = createManagementPaginationService();
      pagination.setPage(2);
      pagination.reconcile(25);
      expect(pagination.page.value).toBe(2);
      expect(managementPageItems(items.slice(0, 25), pagination)).toEqual(
        items.slice(MANAGEMENT_PAGE_SIZE, 25)
      );

      pagination.reconcile(10);
      expect(pagination.page.value).toBe(1);
      expect(managementPageItems(items.slice(0, 10), pagination)).toEqual(items.slice(0, 10));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('maps conversation hosting audit events in both supported locales', () => {
    const events = [
      ['conversation_hosting_disabled', 'node', 'hostingDisable'],
      ['conversation_hosting_storage_inspected', 'node', 'storageInspect']
    ] as const;

    for (const [eventType, business, action] of events) {
      expect(classifyAuditEvent({ eventType })).toEqual([business, action]);
      expect(en.audit.actions[action]).toBeTruthy();
      expect(zh.audit.actions[action]).toBeTruthy();
    }
  });
});
