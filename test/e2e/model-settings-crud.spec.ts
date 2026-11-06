import { expect, test } from '@playwright/test';
import mysql from 'mysql2/promise';
import { MarAgentModelService } from '../../packages/server-core/src/mar-agent-model-service.js';
import type { MysqlServerDatabase } from '../../ee/server/src/mysql/server-database.js';
import { MarAgentModelService as EnterpriseMarAgentModelService } from '../../ee/server/src/service/mar-agent-model-service.js';
import { createEnterpriseTestServer } from './support/enterprise-test-server.js';

test('enterprise model summaries preserve Subagent usage after saving and reloading', async () => {
  const server = await createEnterpriseTestServer('model-subagent-usage');
  const pool = mysql.createPool(server.databaseUrl);
  const database = { raw: pool } as MysqlServerDatabase;
  const models = new EnterpriseMarAgentModelService(database, Date.now, () => 'subagent-model');
  try {
    const [users] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT id FROM users WHERE is_fixed_admin=TRUE'
    );
    const userId = Number(users[0]!['id']);
    const created = await models.create(userId, {
      name: 'Subagent model',
      protocol: 'ANTHROPIC_MESSAGES',
      baseUrl: 'https://models.example.test',
      credential: { type: 'INLINE_API_KEY', value: 'fixture-secret' },
      modelId: 'upstream-model',
      contextWindowTokens: 200_000,
      maxOutputTokens: 16_384,
      inputCapabilities: ['TEXT'],
      outputCapabilities: ['TEXT'],
      reasoningEfforts: ['high'],
      defaultReasoningEffort: 'high',
      hostedWebSearch: false,
      enabled: true
    });
    expect(created.subagentModel).toBe(false);
    expect(created.unifiedCompact).toBe(false);

    for (const subagentModel of [true, false]) {
      expect(await models.update(userId, created.id, { subagentModel })).toMatchObject({
        id: created.id,
        conversationModel: true,
        subagentModel
      });
      const reader = new EnterpriseMarAgentModelService(database);
      for (const summaries of [
        await reader.listManagedForUser(userId),
        await reader.listForUser(userId)
      ]) {
        expect(summaries).toEqual([
          expect.objectContaining({ id: created.id, conversationModel: true, subagentModel })
        ]);
      }
      expect(await reader.stored(created.id)).toMatchObject({ subagentModel });
      expect(await reader.update(userId, created.id, { name: 'Renamed model' })).toMatchObject({
        subagentModel
      });
    }
  } finally {
    await pool.end();
    await server.close();
  }
});

test('model settings follow transactional create, duplicate, update and deletion', async () => {
  const server = await createEnterpriseTestServer('model-settings-crud');
  const pool = mysql.createPool(server.databaseUrl);
  const ids = ['m'.repeat(128), 'copy-model'];
  let rejectSettingsWrite = false;
  const faultInjectionPool = new Proxy(pool, {
    get(target, property) {
      if (property === 'getConnection')
        return async () => {
          const connection = await target.getConnection();
          return new Proxy(connection, {
            get(current, key) {
              const member: unknown = Reflect.get(current, key, current);
              if (key === 'execute' && typeof member === 'function')
                return (...args: unknown[]) => {
                  if (
                    rejectSettingsWrite &&
                    String(args[0]).startsWith('INSERT INTO system_settings')
                  )
                    throw new Error('injected settings failure');
                  return Reflect.apply(member, current, args);
                };
              return typeof member === 'function' ? member.bind(current) : member;
            }
          });
        };
      const member: unknown = Reflect.get(target, property, target);
      return typeof member === 'function' ? member.bind(target) : member;
    }
  });
  const models = new MarAgentModelService({ raw: faultInjectionPool }, Date.now, () =>
    ids.shift()!
  );
  try {
    const [users] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT id FROM users WHERE is_fixed_admin=TRUE'
    );
    const userId = Number(users[0]!['id']);
    const input = {
      name: 'Settings Source',
      protocol: 'OPENAI_RESPONSES',
      baseUrl: 'https://models.example.test/v1',
      credential: { type: 'INLINE_API_KEY', value: 'fixture-secret' },
      modelId: 'upstream-fast-model',
      contextWindowTokens: 200_000,
      maxOutputTokens: 16_384,
      inputCapabilities: ['TEXT'],
      outputCapabilities: ['TEXT'],
      reasoningEfforts: ['high'],
      defaultReasoningEffort: 'high',
      hostedWebSearch: true,
      serviceTier: 'priority',
      responsesTransport: { transport: 'HTTP', httpVersion: '2' },
      responsesPreviousResponseId: true,
      unifiedCompact: true,
      enabled: true,
      sortOrder: 0
    };
    const created = await models.create(userId, input);
    expect(created).toMatchObject({
      id: 'm'.repeat(128),
      unifiedCompact: true,
      modelId: input.modelId,
      serviceTier: 'priority'
    });
    const copy = await models.duplicate(userId, created.id, { ...input, name: 'Settings Copy' });
    expect(copy).toMatchObject({
      id: 'copy-model',
      unifiedCompact: true,
      modelId: input.modelId,
      serviceTier: 'priority'
    });
    await models.update(userId, created.id, { name: 'Updated Source', serviceTier: 'flex' });
    expect(await models.stored(created.id)).toMatchObject({
      name: 'Updated Source',
      unifiedCompact: true,
      serviceTier: 'flex'
    });

    rejectSettingsWrite = true;
    await expect(
      models.update(userId, created.id, {
        name: 'Must Roll Back',
        serviceTier: 'priority',
        unifiedCompact: false
      })
    ).rejects.toThrow('injected settings failure');
    rejectSettingsWrite = false;
    expect(await models.stored(created.id)).toMatchObject({
      name: 'Updated Source',
      unifiedCompact: true,
      serviceTier: 'flex'
    });
    await models.update(userId, created.id, { unifiedCompact: false });
    const reloaded = new MarAgentModelService({ raw: pool });
    expect(await reloaded.stored(created.id)).toMatchObject({ unifiedCompact: false });
    expect(await reloaded.listManagedForUser(userId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: created.id, unifiedCompact: false }),
        expect.objectContaining({ id: copy.id, unifiedCompact: true })
      ])
    );
    await models.remove(created.id, userId);
    await models.remove(copy.id, userId);
    const [settings] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT setting_key FROM system_settings WHERE setting_key IN (?,?)',
      [`mar_agent_model_config:${created.id}`, `mar_agent_model_config:${copy.id}`]
    );
    expect(settings).toEqual([]);
  } finally {
    await pool.end();
    await server.close();
  }
});

test('model row and protocol settings are projected from one database snapshot during concurrent update', async () => {
  const server = await createEnterpriseTestServer('model-settings-snapshot');
  const pool = mysql.createPool(server.databaseUrl);
  const input = {
    name: 'Snapshot model',
    protocol: 'OPENAI_RESPONSES',
    baseUrl: 'https://example.invalid/v1',
    credential: { type: 'INLINE_API_KEY', value: 'test-key' },
    modelId: 'snapshot-model',
    contextWindowTokens: 8192,
    maxOutputTokens: 1024,
    inputCapabilities: ['TEXT'],
    outputCapabilities: ['TEXT'],
    reasoningEfforts: ['high'],
    defaultReasoningEffort: 'high',
    enabled: true,
    hostedWebSearch: true
  };
  try {
    const writer = new MarAgentModelService({ raw: pool } as never, Date.now, () => 'snapshot-id');
    await writer.create(1, input);
    let injected = false;
    const intercepted = new Proxy(pool, {
      get(target, key) {
        if (key === 'execute')
          return async (...args: unknown[]) => {
            const result = await Reflect.apply(target.execute, target, args);
            if (!injected && typeof args[0] === 'string' && args[0].includes('AS model_settings')) {
              injected = true;
              const connection = await pool.getConnection();
              try {
                await connection.beginTransaction();
                await connection.execute(
                  "UPDATE mar_agent_models SET protocol='ANTHROPIC_MESSAGES' WHERE id='snapshot-id'"
                );
                await connection.execute(
                  "UPDATE system_settings SET setting_value=CAST(? AS JSON) WHERE setting_key='mar_agent_model_config:snapshot-id'",
                  ['{"version":1}']
                );
                await connection.commit();
              } catch (error) {
                await connection.rollback();
                throw error;
              } finally {
                connection.release();
              }
            }
            return result;
          };
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    const reader = new MarAgentModelService({ raw: intercepted } as never);
    const models = await reader.list();
    expect(injected).toBe(true);
    expect(models).toEqual([
      expect.objectContaining({
        id: 'snapshot-id',
        protocol: 'OPENAI_RESPONSES',
        hostedWebSearch: true
      })
    ]);
    await expect(writer.list()).resolves.toEqual([
      expect.objectContaining({ id: 'snapshot-id', protocol: 'ANTHROPIC_MESSAGES' })
    ]);
  } finally {
    await pool.end();
    await server.close();
  }
});
