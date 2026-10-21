import type { PoolConnection } from 'mysql2/promise';

export interface AuditEvent {
  readonly eventType: string;
  readonly occurredAt?: number;
  readonly actorUserId?: number;
  readonly actorUsername?: string;
  readonly ipAddress?: string;
  readonly metadata?: string;
  readonly result?: 'SUCCESS' | 'DENIED' | 'FAILED';
  readonly errorCode?: string;
  readonly authenticationMethod?: 'PASSWORD' | 'OAUTH2' | 'SYSTEM';
  readonly providerId?: string;
  readonly requestId?: string;
  readonly operationId?: string;
  readonly sessionPublicId?: string;
  readonly targetType?: string;
  readonly targetId?: string;
  readonly targetName?: string;
  readonly organizationId?: number;
  readonly nodeId?: string;
  readonly workspaceId?: string;
  readonly agentSessionId?: string;
  readonly runId?: string;
  readonly clientMessageId?: string;
  readonly queueItemId?: string;
  readonly inputMode?: string;
}

export interface AuditObserver {
  audit(event: AuditEvent): Promise<void> | void;
}

/** Domain producers pass only their already-authorized object, not the request. */
export function resourceAuditEvent<T extends AuditEvent>(
  event: T,
  snapshot: Readonly<Record<string, unknown>>,
  metadata: Readonly<Record<string, unknown>> = {}
): T & AuditEvent & { readonly metadata: string } {
  const ownership = snapshot['ownership'];
  if (ownership !== null && typeof ownership === 'object' && !Array.isArray(ownership))
    snapshot = { ...snapshot, ...ownership };
  const organizationId =
    snapshot['ownerOrganizationId'] ??
    snapshot['owner_organization_id'] ??
    snapshot['organizationId'] ??
    snapshot['organization_id'];
  const ownerType = snapshot['ownerType'] ?? snapshot['owner_type'] ?? snapshot['scope'];
  const name =
    event.targetName ??
    snapshot['name'] ??
    snapshot['displayName'] ??
    snapshot['display_name'] ??
    snapshot['normalized_name'] ??
    snapshot['username'];
  const nameKey = (
    {
      NODE: 'nodeName',
      WORKSPACE: 'workspaceName',
      SESSION: 'sessionName',
      ORGANIZATION: 'organizationName'
    } as Readonly<Record<string, string>>
  )[event.targetType ?? ''];
  const names = Object.fromEntries(
    [
      'nodeId',
      'workspaceId',
      'nodeName',
      'workspaceName',
      'sessionName',
      'organizationName',
      'targetUserName',
      'targetOrganizationName'
    ]
      .filter((key) => typeof snapshot[key] === 'string')
      .map((key) => [key, snapshot[key]])
  );
  return {
    ...event,
    occurredAt: event.occurredAt ?? Date.now(),
    ...(ownerType === 'ENTERPRISE'
      ? { organizationId: 1 }
      : organizationId == null
        ? {}
        : { organizationId: Number(organizationId) }),
    ...(typeof name === 'string' ? { targetName: name } : {}),
    metadata: safeAuditMetadata(
      JSON.stringify({
        ...names,
        ...metadata,
        ...(nameKey &&
        typeof name === 'string' &&
        metadata[nameKey] === undefined &&
        names[nameKey] === undefined
          ? { [nameKey]: name }
          : {}),
        ...(ownerType === undefined ? {} : { ownerType })
      })
    )
  };
}

export function emitAudit(observer: Partial<AuditObserver>, event: AuditEvent): void {
  try {
    void Promise.resolve(observer.audit?.(event)).catch(() => console.warn('AUDIT_WRITE_FAILED'));
  } catch {
    console.warn('AUDIT_WRITE_FAILED');
  }
}

/** Audit failures must never become business failures or retain unbounded payloads. */
export class AsyncAuditWriter {
  private readonly pending: Array<() => Promise<void>> = [];
  private active = 0;

  constructor(
    private readonly diagnostic: (code: string) => void = () => undefined,
    private readonly concurrency = 4,
    private readonly capacity = 128
  ) {}

  dispatch(write: () => Promise<void>): void {
    if (this.pending.length + this.active >= this.capacity) {
      this.report('AUDIT_CAPACITY_EXCEEDED');
      return;
    }
    this.pending.push(write);
    this.pump();
  }

  private pump(): void {
    while (this.active < this.concurrency && this.pending.length > 0) {
      const write = this.pending.shift()!;
      this.active++;
      void Promise.resolve()
        .then(write)
        .catch(() => this.report('AUDIT_WRITE_FAILED'))
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
  }

  private report(code: string): void {
    try {
      this.diagnostic(code);
    } catch {
      /* Diagnostics cannot affect business execution. */
    }
  }
}

const deferred = new WeakMap<object, Array<() => void>>();

/** Capture an audit intent without writing through the business connection. */
export function deferMysqlAudit(connection: object, dispatch: () => void): void {
  const events = deferred.get(connection) ?? [];
  events.push(dispatch);
  deferred.set(connection, events);
}

export function commitMysqlAudits(connection: object): void {
  const events = deferred.get(connection);
  deferred.delete(connection);
  for (const dispatch of events ?? []) {
    try {
      dispatch();
    } catch {
      console.warn('AUDIT_WRITE_FAILED');
    }
  }
}

export function discardMysqlAudits(connection: object): void {
  deferred.delete(connection);
}

export function emitAuditAfterCommit(
  observer: Partial<AuditObserver>,
  connection: object,
  event: AuditEvent
): void {
  const snapshot = {
    ...event,
    occurredAt: event.occurredAt ?? Date.now(),
    metadata: safeAuditMetadata(event.metadata)
  };
  deferMysqlAudit(connection, () => emitAudit(observer, snapshot));
}

export type AuditConnection = Pick<PoolConnection, 'execute'>;

const metadataKeys = new Set([
  'action',
  'phase',
  'category',
  'name',
  'scope',
  'deliveryIntent',
  'expiresAt',
  'licenseId',
  'nodeId',
  'workspaceId',
  'sessionId',
  'runId',
  'requestId',
  'userId',
  'secretId',
  'skillSourceId',
  'skillFavoriteId',
  'skillInstallJobId',
  'version',
  'targetVersion',
  'sourceName',
  'nodeName',
  'workspaceName',
  'sessionName',
  'organizationName',
  'targetUserName',
  'targetOrganizationName',
  'targetType',
  'targetUserId',
  'targetOrganizationId',
  'parentOrganizationId',
  'ownerType',
  'ownerOrganizationId',
  'relativePath',
  'destination',
  'fileName',
  'sizeBytes',
  'state',
  'deletedCount',
  'skippedCount',
  'failedCount',
  'enabled',
  'role',
  'before',
  'after',
  'templateId',
  'modelId',
  'catalogEntryId',
  'revision',
  'jobId',
  'versionId',
  'terminalId',
  'uploadId',
  'mutation',
  'inputMode'
]);
const changeKeys = new Set([
  'name',
  'parentOrganizationId',
  'organizationId',
  'role',
  'enabled',
  'ownerType',
  'ownerOrganizationId',
  'targetUserId',
  'targetOrganizationId',
  'groupName',
  'version',
  'preserveGitConfig',
  'model',
  'effort',
  'runner',
  'permissionMode',
  'featured',
  'provider'
]);

export function safeAuditMetadata(value: string | undefined): string {
  if (!value) return '{}';
  try {
    const input: unknown = JSON.parse(value);
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return '{}';
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(input)) {
      if (!metadataKeys.has(key)) continue;
      if (
        (key === 'before' || key === 'after') &&
        item !== null &&
        typeof item === 'object' &&
        !Array.isArray(item)
      ) {
        result[key] = Object.fromEntries(
          Object.entries(item)
            .filter(([field, text]) => changeKeys.has(field) && scalar(text))
            .map(([field, text]) => [field, bounded(text)])
        );
      } else if (scalar(item)) result[key] = bounded(item);
    }
    return JSON.stringify(result);
  } catch {
    return '{}';
  }
}

function scalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}
function bounded(value: unknown): unknown {
  return typeof value === 'string' ? value.slice(0, 512) : value;
}
