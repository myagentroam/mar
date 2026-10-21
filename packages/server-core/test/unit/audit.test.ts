import { describe, expect, it, vi } from 'vitest';
import {
  AsyncAuditWriter,
  commitMysqlAudits,
  deferMysqlAudit,
  discardMysqlAudits,
  resourceAuditEvent,
  safeAuditMetadata
} from '../../src/audit.js';

describe('AsyncAuditWriter', () => {
  it('returns immediately for slow writes and contains rejected writes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const diagnostic = vi.fn();
    const writer = new AsyncAuditWriter(diagnostic, 1, 4);
    const write = vi.fn(async () => {
      await gate;
      throw new Error('database unavailable');
    });

    let callerReturned = false;
    expect(() => writer.dispatch(write)).not.toThrow();
    callerReturned = true;
    expect(callerReturned).toBe(true);
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());

    release();
    await vi.waitFor(() => expect(diagnostic).toHaveBeenCalledWith('AUDIT_WRITE_FAILED'));
  });

  it('bounds concurrency and drops work after capacity is full', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let active = 0;
    let maximumActive = 0;
    let completed = 0;
    const diagnostic = vi.fn(() => {
      throw new Error('diagnostic unavailable');
    });
    const writer = new AsyncAuditWriter(diagnostic, 2, 3);
    const writes = Array.from({ length: 4 }, () =>
      vi.fn(async () => {
        active++;
        maximumActive = Math.max(maximumActive, active);
        await gate;
        active--;
        completed++;
      })
    );

    for (const write of writes) writer.dispatch(write);
    await vi.waitFor(() => expect(writes[0]).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(writes[1]).toHaveBeenCalledOnce());
    expect(writes[2]).not.toHaveBeenCalled();
    expect(writes[3]).not.toHaveBeenCalled();
    expect(maximumActive).toBe(2);
    expect(diagnostic).toHaveBeenCalledWith('AUDIT_CAPACITY_EXCEEDED');

    release();
    await vi.waitFor(() => expect(completed).toBe(3));
    expect(maximumActive).toBeLessThanOrEqual(2);
  });
});

describe('audit helpers', () => {
  it('does not let diagnostic failures escape the capacity path', () => {
    const diagnostic = vi.fn(() => {
      throw new Error('diagnostic unavailable');
    });
    const writer = new AsyncAuditWriter(diagnostic, 1, 1);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    writer.dispatch(async () => gate);
    expect(() => writer.dispatch(async () => undefined)).not.toThrow();
    expect(diagnostic).toHaveBeenCalledWith('AUDIT_CAPACITY_EXCEEDED');
    release();
  });

  it('commits deferred audits in order and discards them by connection', () => {
    const connection = {};
    const first = vi.fn();
    const second = vi.fn();
    deferMysqlAudit(connection, first);
    deferMysqlAudit(connection, second);

    commitMysqlAudits(connection);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(first.mock.invocationCallOrder[0]).toBeLessThan(second.mock.invocationCallOrder[0]!);

    commitMysqlAudits(connection);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();

    const discarded = vi.fn();
    deferMysqlAudit(connection, discarded);
    discardMysqlAudits(connection);
    commitMysqlAudits(connection);
    expect(discarded).not.toHaveBeenCalled();
  });

  it('keeps only bounded scalar metadata and selected change fields', () => {
    const metadata = safeAuditMetadata(
      JSON.stringify({
        action: 'organization.updated',
        enabled: true,
        userId: 7,
        secret: 'must not persist',
        before: {
          name: 'old name',
          organizationId: 23,
          password: 'must not persist',
          nested: { secret: 'must not persist' }
        },
        after: {
          role: 'ORG_ADMIN',
          version: 2,
          values: ['must not persist']
        },
        oversized: 'x'.repeat(600)
      })
    );

    expect(JSON.parse(metadata)).toEqual({
      action: 'organization.updated',
      enabled: true,
      userId: 7,
      before: { name: 'old name', organizationId: 23 },
      after: { role: 'ORG_ADMIN', version: 2 }
    });
    expect(safeAuditMetadata(undefined)).toBe('{}');
    expect(safeAuditMetadata('{invalid')).toBe('{}');
    expect(safeAuditMetadata(JSON.stringify(['secret']))).toBe('{}');
  });

  it.each([
    ['NODE', 'displayName', 'nodeName'],
    ['WORKSPACE', 'display_name', 'workspaceName'],
    ['ORGANIZATION', 'name', 'organizationName'],
    ['SESSION', 'name', 'sessionName'],
    ['USER', 'username', undefined],
    ['MODEL', 'name', undefined],
    ['TEMPLATE', 'name', undefined]
  ])('freezes friendly %s names and related name metadata', (targetType, field, key) => {
    const snapshot: Record<string, unknown> = {
      [field!]: 'Historical name',
      nodeId: 'node-linked',
      workspaceId: 'workspace-linked',
      nodeName: targetType === 'NODE' ? 'Historical name' : 'Related Node',
      organizationName: targetType === 'ORGANIZATION' ? 'Historical name' : 'Related organization',
      ownerType: 'ORGANIZATION',
      ownerOrganizationId: 7
    };
    const event = resourceAuditEvent(
      { eventType: 'resource.updated', targetType: targetType! },
      snapshot
    );
    snapshot[field!] = 'Later name';
    snapshot.nodeName = 'Later Node';
    snapshot.nodeId = 'node-later';
    snapshot.workspaceId = 'workspace-later';
    expect(event.targetName).toBe('Historical name');
    const metadata = JSON.parse(event.metadata);
    expect(metadata.nodeId).toBe('node-linked');
    expect(metadata.workspaceId).toBe('workspace-linked');
    expect(metadata.nodeName).toBe(targetType === 'NODE' ? 'Historical name' : 'Related Node');
    if (key) expect(metadata[key]).toBe('Historical name');
    expect(JSON.stringify(event)).not.toContain('Later');
  });

  it('creates an immutable resource snapshot without retaining unsafe metadata', () => {
    const preserved = resourceAuditEvent(
      { eventType: 'node.updated', targetType: 'NODE', targetName: 'Saved target' },
      { displayName: 'Later target' },
      { nodeName: 'Saved Node' }
    );
    expect(preserved.targetName).toBe('Saved target');
    expect(JSON.parse(preserved.metadata).nodeName).toBe('Saved Node');
    const snapshot: Record<string, unknown> = {
      ownerOrganizationId: '23',
      owner_type: 'ORGANIZATION',
      display_name: 'Workspace before rename',
      secret: 'must not persist'
    };
    const event = resourceAuditEvent(
      { eventType: 'workspace.updated', targetType: 'WORKSPACE' },
      snapshot,
      { action: 'UPDATE', secret: 'must not persist' }
    );

    snapshot.ownerOrganizationId = 99;
    snapshot.display_name = 'Workspace after rename';

    expect(event).toMatchObject({
      eventType: 'workspace.updated',
      organizationId: 23,
      targetName: 'Workspace before rename',
      metadata: JSON.stringify({
        action: 'UPDATE',
        workspaceName: 'Workspace before rename',
        ownerType: 'ORGANIZATION'
      })
    });
    expect(JSON.stringify(event)).not.toContain('must not persist');

    const enterprise = resourceAuditEvent(
      { eventType: 'organization.workspace.created' },
      { ownerType: 'ENTERPRISE', name: 'Enterprise workspace' }
    );
    const emptySnapshot = resourceAuditEvent({ eventType: 'audit.event' }, {});
    expect(enterprise).toMatchObject({ organizationId: 1, targetName: 'Enterprise workspace' });
    expect(typeof emptySnapshot.metadata).toBe('string');
    expect(emptySnapshot.metadata).toBe('{}');
  });
});
