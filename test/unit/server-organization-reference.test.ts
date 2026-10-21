import { describe, expect, it, vi } from 'vitest';
import { lockOrganizationReference } from '../../ee/server/src/rbac/organization-reference.js';

describe('organization references without Core foreign keys', () => {
  it('does not read private tables for personal ownership', async () => {
    const execute = vi.fn();
    await lockOrganizationReference({ execute }, null);
    expect(execute).not.toHaveBeenCalled();
  });

  it('holds a shared organization lock on the caller transaction connection', async () => {
    const execute = vi.fn(async () => [[{ id: 5 }], []]);
    await lockOrganizationReference({ execute } as never, 5);
    expect(execute).toHaveBeenCalledWith('SELECT id FROM organizations WHERE id=? FOR SHARE', [5]);
  });

  it('rejects missing or malformed organization identities', async () => {
    const execute = vi.fn(async () => [[], []]);
    await expect(lockOrganizationReference({ execute } as never, 5)).rejects.toThrow(
      'ORGANIZATION_NOT_FOUND'
    );
    await expect(lockOrganizationReference({ execute } as never, Number.NaN)).rejects.toThrow(
      'ORGANIZATION_NOT_FOUND'
    );
  });
});
