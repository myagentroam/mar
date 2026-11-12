import {
  emitAuditAfterCommit,
  commitMysqlAudits,
  discardMysqlAudits
} from '@myagentroam/server-core/audit';

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { MysqlServerDatabase } from '../mysql/server-database.js';
import type { ProductCapabilities, ProductCapabilityProvider } from '../product/product-policy.js';
import {
  computeHostFingerprint,
  computeMachineIdFingerprint,
  createLicenseRequestCode,
  evaluateLicense,
  verifyLicenseDocument,
  type LicensePayload
} from './license-domain.js';

export interface LicenseStatus {
  readonly edition: 'COMMUNITY' | 'ENTERPRISE';
  readonly state: 'COMMUNITY' | 'ENTERPRISE_VALID' | 'ENTERPRISE_FROZEN';
  readonly reason: string | null;
  readonly licenseId: string | null;
  readonly enterpriseName: string | null;
  readonly expiresAt: number | null;
  readonly managementWritable: boolean;
}

export class LicenseService implements ProductCapabilityProvider {
  private readonly now: () => number;
  private readonly hostFingerprint: string | null;

  constructor(
    private readonly database: MysqlServerDatabase,
    private readonly publicKey: string,
    options: {
      readonly now?: () => number;
      readonly productUuid?: string | null;
      readonly hostFingerprint?: string;
    } = {}
  ) {
    this.now = options.now ?? Date.now;
    this.hostFingerprint = options.hostFingerprint ?? hostFingerprint(options.productUuid);
  }

  async status(): Promise<LicenseStatus> {
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      `SELECT current_document,ever_activated,trusted_time_high_watermark
       FROM license_state WHERE singleton_id=1`
    );
    const row = rows[0];
    const evaluated = evaluateLicense(
      {
        document:
          row?.['current_document'] === null || row === undefined
            ? null
            : String(row['current_document']),
        everActivated: Boolean(row?.['ever_activated']),
        highWatermark: Number(row?.['trusted_time_high_watermark'] ?? 0)
      },
      { now: this.now(), hostFingerprint: this.hostFingerprint, publicKey: this.publicKey }
    );
    await this.database.raw.execute(
      `INSERT INTO license_state
       (singleton_id,current_document,ever_activated,trusted_time_high_watermark,updated_at)
       VALUES (1,NULL,FALSE,?,?)
       ON DUPLICATE KEY UPDATE trusted_time_high_watermark=GREATEST(trusted_time_high_watermark,VALUES(trusted_time_high_watermark)),updated_at=VALUES(updated_at)`,
      [evaluated.trustedTime, this.now()]
    );
    return publicStatus(evaluated);
  }

  requestCode(): { readonly requestCode: string } {
    if (this.hostFingerprint === null) throw new Error('LICENSE_HOST_UNAVAILABLE');
    return { requestCode: createLicenseRequestCode(this.hostFingerprint, this.now()) };
  }

  async capability(userId: number): Promise<ProductCapabilities> {
    const status = await this.status();
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      'SELECT role,organization_id FROM users WHERE id=?',
      [userId]
    );
    const row = rows[0];
    const role = row?.['role'];
    return {
      edition: status.edition,
      licenseState: status.state,
      role: role === 'ADMIN' || role === 'ORG_ADMIN' || role === 'MEMBER' ? role : null,
      organizationId:
        row?.['organization_id'] === null || row === undefined
          ? null
          : Number(row['organization_id']),
      managementWritable: status.managementWritable
    };
  }

  async import(document: string, actorUserId: number): Promise<LicenseStatus> {
    if (this.hostFingerprint === null) throw new Error('LICENSE_HOST_UNAVAILABLE');
    const payload = verifyLicenseDocument(document, this.publicKey);
    const connection = await this.database.raw.getConnection();
    try {
      await connection.beginTransaction();
      const [stateRows] = await connection.execute<RowDataPacket[]>(
        `SELECT ever_activated,trusted_time_high_watermark FROM license_state
         WHERE singleton_id=1 FOR UPDATE`
      );
      const prior = stateRows[0];
      const trustedTime = Math.max(this.now(), Number(prior?.['trusted_time_high_watermark'] ?? 0));
      validateActivation(payload, this.hostFingerprint, trustedTime);
      const firstActivation = !prior?.['ever_activated'];
      if (firstActivation) {
        await convergeFirstActivation(connection, payload, trustedTime);
      } else {
        const [enterpriseRows] = await connection.execute<RowDataPacket[]>(
          'SELECT name FROM enterprises WHERE id=1 FOR UPDATE'
        );
        if (String(enterpriseRows[0]?.['name'] ?? '') !== payload.enterpriseName)
          throw new Error('LICENSE_ENTERPRISE_MISMATCH');
      }
      await connection.execute(
        `INSERT INTO license_state
         (singleton_id,current_document,ever_activated,trusted_time_high_watermark,
          last_valid_license_id,last_valid_expires_at,updated_at)
         VALUES (1,?,TRUE,?,?,?,?)
         ON DUPLICATE KEY UPDATE current_document=VALUES(current_document),ever_activated=TRUE,
          trusted_time_high_watermark=GREATEST(trusted_time_high_watermark,VALUES(trusted_time_high_watermark)),
          last_valid_license_id=VALUES(last_valid_license_id),
          last_valid_expires_at=VALUES(last_valid_expires_at),updated_at=VALUES(updated_at)`,
        [document, trustedTime, payload.licenseId, payload.expiresAt, trustedTime]
      );
      await connection.execute(
        `INSERT IGNORE INTO license_activations
         (id,license_id,enterprise_name,host_fingerprint,issued_at,expires_at,activated_at)
         VALUES (?,?,?,?,?,?,?)`,
        [
          randomUUID(),
          payload.licenseId,
          payload.enterpriseName,
          payload.hostFingerprint,
          payload.issuedAt,
          payload.expiresAt,
          trustedTime
        ]
      );
      emitAuditAfterCommit(this.database, connection, {
        eventType: firstActivation ? 'license_activated' : 'license_replaced',
        actorUserId,
        metadata: JSON.stringify({ licenseId: payload.licenseId, expiresAt: payload.expiresAt })
      });
      await connection.commit();
      commitMysqlAudits(connection);
    } catch (error) {
      discardMysqlAudits(connection);
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    return this.status();
  }
}

/** Linux Quick Start binds licenses to the OS instance without reading privileged DMI files. */
export function readQuickStartHostFingerprint(path = '/etc/machine-id'): string {
  try {
    return computeMachineIdFingerprint(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('LICENSE_HOST_UNAVAILABLE');
  }
}

export function readLicenseHostUuid(
  path = process.env['MAR_LICENSE_HOST_PATH'] ?? '/sys/class/dmi/id/product_uuid'
): string {
  try {
    const value = readFileSync(path, 'utf8');
    computeHostFingerprint(value);
    return value;
  } catch {
    throw new Error('LICENSE_HOST_UNAVAILABLE');
  }
}

function hostFingerprint(productUuid: string | null | undefined): string | null {
  try {
    const value = productUuid === undefined ? readLicenseHostUuid() : productUuid;
    return value === null ? null : computeHostFingerprint(value);
  } catch {
    return null;
  }
}

function validateActivation(
  payload: LicensePayload,
  currentHostFingerprint: string,
  trustedTime: number
): void {
  if (payload.hostFingerprint !== currentHostFingerprint) throw new Error('LICENSE_HOST_MISMATCH');
  if (trustedTime < payload.issuedAt) throw new Error('LICENSE_NOT_YET_VALID');
  if (trustedTime >= payload.expiresAt) throw new Error('LICENSE_EXPIRED');
}

async function convergeFirstActivation(
  connection: PoolConnection,
  payload: LicensePayload,
  timestamp: number
): Promise<void> {
  await connection.execute(
    `INSERT INTO enterprises (id,name,activated_at,updated_at) VALUES (1,?,?,?)
     ON DUPLICATE KEY UPDATE name=VALUES(name),updated_at=VALUES(updated_at)`,
    [payload.enterpriseName, timestamp, timestamp]
  );
  await connection.execute(
    `INSERT INTO organizations (id,name,parent_organization_id,created_at,updated_at)
     VALUES (1,?,NULL,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name),updated_at=VALUES(updated_at)`,
    [payload.enterpriseName, timestamp, timestamp]
  );
  await connection.execute(
    `UPDATE users SET organization_id=1,
      role=IF(is_fixed_admin,'ADMIN','MEMBER'),updated_at=?`,
    [timestamp]
  );
  await connection.execute(
    `UPDATE nodes SET owner_type='PERSONAL',owner_user_id=registered_by_user_id,
      owner_organization_id=NULL,legacy_ownership_backfill_pending=TRUE,updated_at=?`,
    [timestamp]
  );
  await connection.execute(
    `UPDATE workspaces w JOIN nodes n ON n.id=w.node_id
     SET w.owner_type='PERSONAL',w.owner_user_id=n.owner_user_id,w.owner_organization_id=NULL`
  );
  const [invalidRows] = await connection.execute<RowDataPacket[]>(
    `SELECT
      (SELECT COUNT(*) FROM users WHERE organization_id IS NULL OR organization_id<>1 OR role IS NULL OR
        (is_fixed_admin=TRUE AND role<>'ADMIN')) +
      (SELECT COUNT(*) FROM nodes WHERE (owner_type<>'PERSONAL' OR owner_user_id IS NULL OR owner_organization_id IS NOT NULL)) +
      (SELECT COUNT(*) FROM workspaces w JOIN nodes n ON n.id=w.node_id
        WHERE (w.owner_type<>'PERSONAL' OR w.owner_user_id<>n.owner_user_id OR
          w.owner_organization_id IS NOT NULL)) AS count`
  );
  if (Number(invalidRows[0]?.['count'] ?? 0) !== 0)
    throw new Error('LICENSE_FIRST_ACTIVATION_CONVERGENCE_FAILED');
}

function publicStatus(evaluated: ReturnType<typeof evaluateLicense>): LicenseStatus {
  return {
    edition: evaluated.state === 'COMMUNITY' ? 'COMMUNITY' : 'ENTERPRISE',
    state: evaluated.state,
    reason: evaluated.reason ?? null,
    licenseId: evaluated.payload?.licenseId ?? null,
    enterpriseName: evaluated.payload?.enterpriseName ?? null,
    expiresAt: evaluated.payload?.expiresAt ?? null,
    managementWritable: evaluated.state !== 'ENTERPRISE_FROZEN'
  };
}
