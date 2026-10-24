import { createResourceHostingService as createCore } from '@myagentroam/web-core/resource-hosting';
import type { EnterpriseResourceRow } from './resource-ownership-service.js';
export function createResourceHostingService(
  request: <T>(path: string, init?: RequestInit) => Promise<T>,
  context: () => {
    role: 'ADMIN' | 'ORG_ADMIN' | 'MEMBER' | null;
    writable: boolean;
    edition?: 'COMMUNITY' | 'ENTERPRISE';
  }
) {
  return createCore<EnterpriseResourceRow>(request, () => ({
    writable: context().writable,
    visible: (row) =>
      (context().edition === 'COMMUNITY' || context().role === 'ADMIN') &&
      (context().edition === 'COMMUNITY' ||
        row.ownership.ownerType === 'ORGANIZATION' ||
        (row.capabilities?.conversationHosting !== undefined &&
          row.capabilities.conversationHosting.state !== 'DISABLED')),
    canEnable: (row) =>
      context().edition === 'COMMUNITY' || row.ownership.ownerType === 'ORGANIZATION'
  }));
}
