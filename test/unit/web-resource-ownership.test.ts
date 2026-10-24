import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick } from 'vue';
import {
  createResourceOwnershipService,
  type EnterpriseResourceRow
} from '../../ee/web/src/service/resource-ownership-service.js';

const personal: EnterpriseResourceRow = {
  key: 'node-1',
  resourceType: 'NODE',
  nodeId: 'node-1',
  workspaceId: null,
  label: 'Node',
  ownership: { ownerType: 'PERSONAL', ownerUserId: 2 }
};
const organization: EnterpriseResourceRow = {
  ...personal,
  key: 'node-2',
  nodeId: 'node-2',
  ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 7 }
};
let scope = effectScope();
beforeEach(() => {
  scope = effectScope();
  vi.stubGlobal('window', {
    location: { search: '', href: 'http://localhost/console?nodes.keyword=keep' },
    history: { replaceState: vi.fn() }
  });
});
afterEach(() => {
  scope.stop();
  vi.unstubAllGlobals();
});
function create(request = vi.fn(), edition: 'COMMUNITY' | 'ENTERPRISE' = 'ENTERPRISE') {
  return scope.run(() =>
    createResourceOwnershipService(request, () => ({
      edition,
      role: 'ADMIN',
      resourceType: 'NODE'
    }))
  )!;
}
describe('Enterprise resource ownership extension', () => {
  it('does not request enterprise directories for community edition', async () => {
    const request = vi.fn();
    const service = create(request, 'COMMUNITY');
    await service.load();
    expect(request).not.toHaveBeenCalled();
    expect(service.registrationBody('Node')).toEqual({ displayName: 'Node' });
  });
  it('loads organization and user directories and tolerates unavailable directories', async () => {
    const request = vi.fn(async (path: string) => {
      if (path === '/api/organizations')
        return { organizations: [{ id: 7, name: 'Platform', parentOrganizationId: null }] };
      throw new Error('Directory unavailable');
    });
    const service = create(request);
    await service.load();
    expect(service.organizationOptions.value).toEqual([
      { value: 7, label: 'Platform', children: [] }
    ]);
    expect(service.users.value).toEqual([]);
    expect(service.label(organization)).toBe('Platform');
    expect(
      service.label({
        ...organization,
        ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 99 }
      })
    ).toBe('99');
  });
  it('keeps organization ownership identifiable when its directory fails to load', async () => {
    const service = create(vi.fn().mockRejectedValue(new Error('Directory unavailable')));
    await service.load();
    expect(service.label(organization)).toBe('7');
    expect(service.label(personal)).not.toBe('');
  });
  it('preserves scalar registration ownership and clears stale organization IDs between edits', () => {
    const service = create();
    service.registrationOwner.value = 7;
    expect(service.registrationBody('Node')).toEqual({
      displayName: 'Node',
      ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 7 }
    });
    service.prepareEdit(organization);
    service.editOrganizationId.value = 8;
    expect(service.editBody(organization, ' Renamed ')).toEqual({
      displayName: 'Renamed',
      ownership: { ownerType: 'ORGANIZATION', ownerOrganizationId: 8 }
    });
    service.prepareEdit(personal);
    expect(service.editOrganizationId.value).toBeUndefined();
    expect(service.editBody(personal, ' Renamed ')).toEqual({ displayName: 'Renamed' });
  });
  it('filters ownership independently while retaining common URL filter keys', async () => {
    const service = create();
    service.ownerType.value = 'PERSONAL';
    await nextTick();
    service.ownerUserId.value = 2;
    expect(service.matches(personal)).toBe(true);
    expect(service.matches(organization)).toBe(false);
    service.ownerType.value = 'ORGANIZATION';
    await nextTick();
    expect(service.ownerUserId.value).toBeUndefined();
    service.ownerOrganizationId.value = 7;
    await nextTick();
    expect(service.matches(organization)).toBe(true);
    expect(service.matches(personal)).toBe(false);
    expect(window.history.replaceState).toHaveBeenLastCalledWith(
      null,
      '',
      '/console?nodes.keyword=keep&nodes.ownerType=ORGANIZATION&nodes.organization=7'
    );
  });
});
