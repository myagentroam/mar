import { AuditService } from '../../ee/server/src/audit/audit-service.js';
import type { AuthorizationProvider } from '../../ee/server/src/product/product-policy.js';
import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
  type APIResponse
} from '@playwright/test';
import mysql from 'mysql2/promise';
import { MysqlServerDatabase } from '../../ee/server/src/mysql/server-database.js';
import { createPlaywrightTestLicenseDocument } from './support/playwright-test-license.js';
import { createEnterpriseTestServer } from './support/enterprise-test-server.js';
import { INITIAL_ADMIN_PASSWORD } from '../../packages/server-core/src/password.js';

test('Shared Node conversation audits deduplicate transactionally in MySQL and explicitly clean up content', async ({
  browserName
}) => {
  test.skip(browserName !== 'chromium', 'The shared MySQL storage check is exercised once.');
  const server = await createEnterpriseTestServer('shared-conversation-audit-storage');
  const database = new MysqlServerDatabase(mysql.createPool(server.databaseUrl));
  let actor: { context: APIRequestContext; csrfToken: string } | undefined;
  try {
    actor = await login(server.baseURL);
    const imported = await actor.context.post('/api/license/import', {
      headers: { 'x-csrf-token': actor.csrfToken },
      data: { document: createPlaywrightTestLicenseDocument() }
    });
    await expectJson(imported, 200);
    const [adminRows] = await database.raw.execute<mysql.RowDataPacket[]>(
      'SELECT id,organization_id FROM users WHERE is_fixed_admin=TRUE'
    );
    const adminUserId = Number(adminRows[0]?.['id']);
    const organizationId = Number(adminRows[0]?.['organization_id']);
    expect(Number.isSafeInteger(adminUserId)).toBe(true);
    expect(Number.isSafeInteger(organizationId)).toBe(true);
    const registration = await database.createNodeRegistrationToken(adminUserId, 60_000, {
      ownerType: 'ORGANIZATION',
      ownerOrganizationId: organizationId
    });
    const node = await database.registerNode(registration.token, { metadata: '{}' });
    expect(node).toBeDefined();
    const idempotencyKey = 'a'.repeat(64);

    await database.recordConversationAudit({
      eventType: 'shared_conversation_input_accepted',
      actorUserId: adminUserId,
      organizationId,
      nodeId: node!.nodeId,
      workspaceId: 'workspace-audit',
      targetType: 'SESSION',
      targetId: 'session-audit',
      targetName: 'Shared audit session',
      agentSessionId: 'session-audit',
      runId: 'run-audit',
      clientMessageId: 'message-audit',
      queueItemId: 'queue-audit',
      inputMode: 'SEND',
      idempotencyKey,
      conversationId: 'session-audit',
      conversationTitle: 'Shared audit session',
      userMessage: 'Persist this only in the protected payload.'
    });
    await database.recordConversationAudit({
      eventType: 'shared_conversation_input_accepted',
      actorUserId: adminUserId,
      organizationId,
      nodeId: node!.nodeId,
      workspaceId: 'workspace-audit',
      targetType: 'SESSION',
      targetId: 'session-audit',
      targetName: 'Shared audit session',
      agentSessionId: 'session-audit',
      runId: 'run-audit',
      clientMessageId: 'message-audit',
      queueItemId: 'queue-audit',
      inputMode: 'SEND',
      idempotencyKey,
      conversationId: 'session-audit',
      conversationTitle: 'Shared audit session',
      userMessage: 'Persist this only in the protected payload.'
    });

    const [events] = await database.raw.execute<mysql.RowDataPacket[]>(
      `SELECT event.id,event.idempotency_key,event.queue_item_id,payload.user_message
       FROM audit_events event
       JOIN audit_conversation_payloads payload ON payload.audit_event_id=event.id
       WHERE event.idempotency_key=?`,
      [idempotencyKey]
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.['queue_item_id']).toBe('queue-audit');
    expect(events[0]?.['user_message']).toBe('Persist this only in the protected payload.');
    await database.raw.execute('UPDATE audit_events SET occurred_at=1 WHERE id=?', [
      events[0]?.['id']
    ]);
    const audit = new AuditService(database, {} as AuthorizationProvider);
    expect(await audit.cleanupBatch()).toBeGreaterThanOrEqual(1);
    const [payloads] = await database.raw.execute<mysql.RowDataPacket[]>(
      'SELECT audit_event_id FROM audit_conversation_payloads WHERE audit_event_id=?',
      [events[0]?.['id']]
    );
    expect(payloads).toEqual([]);
  } finally {
    await actor?.context.dispose();
    await database.close();
    await server.close();
  }
});

async function login(baseURL: string): Promise<{ context: APIRequestContext; csrfToken: string }> {
  const bootstrap = await playwrightRequest.newContext({ baseURL });
  try {
    const response = await bootstrap.post('/api/auth/login', {
      data: { username: 'admin', password: INITIAL_ADMIN_PASSWORD }
    });
    const body = await expectJson<{ csrfToken: string }>(response, 200);
    const cookie = responseCookie(response);
    const password = 'SharedConversationAudit123!';
    const changed = await bootstrap.post('/api/auth/change-password', {
      headers: { 'x-csrf-token': body.csrfToken, cookie },
      data: { currentPassword: INITIAL_ADMIN_PASSWORD, password }
    });
    const changedBody = await expectJson<{ csrfToken: string }>(changed, 200);
    const context = await playwrightRequest.newContext({
      baseURL,
      extraHTTPHeaders: { cookie: responseCookie(changed) }
    });
    return { context, csrfToken: changedBody.csrfToken };
  } finally {
    await bootstrap.dispose();
  }
}

async function expectJson<T>(response: APIResponse, status: number): Promise<T> {
  const body = (await response.json()) as T;
  expect(response.status(), JSON.stringify(body)).toBe(status);
  return body;
}

function responseCookie(response: APIResponse): string {
  const value = response.headers()['set-cookie'];
  if (value === undefined) throw new Error('SESSION_COOKIE_MISSING');
  return value.split(';', 1)[0]!;
}
