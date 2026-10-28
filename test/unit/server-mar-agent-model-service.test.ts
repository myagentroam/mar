import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { MarAgentModelService as CoreMarAgentModelService } from '../../packages/server-core/src/mar-agent-model-service.js';
import {
  codexModelCatalogSchema,
  marAgentStoredModelConfigurationSchema,
  type CodexModelCatalog
} from '../../packages/protocol/src/index.js';
import type { MysqlServerDatabase } from '../../ee/server/src/mysql/server-database.js';
import { MarAgentModelService } from '../../ee/server/src/service/mar-agent-model-service.js';

function database(responses: unknown[] = []) {
  const settings = new Map<string, string>();
  let candidateRows: readonly Record<string, unknown>[] | undefined;
  const execute = vi.fn(async (...args: unknown[]) => {
    const sql = String(args[0]);
    const values = Array.isArray(args[1]) ? args[1] : [];
    if (sql.startsWith('SELECT id,owner_type,owner_user_id,created_by FROM mar_agent_models')) {
      const response = responses.shift() ?? [candidateRows ?? [], []];
      if (
        Array.isArray(response) &&
        Array.isArray(response[0]) &&
        response[0].every((row: unknown) => typeof row === 'object' && row !== null)
      ) {
        const [rows, metadata] = response as [readonly Record<string, unknown>[], unknown];
        candidateRows = rows.filter(
          (row) =>
            (!sql.includes('enabled=1') ||
              row['enabled'] === undefined ||
              Boolean(row['enabled'])) &&
            (!sql.includes('conversation_model=1') ||
              row['conversation_model'] === undefined ||
              Boolean(row['conversation_model']))
        );
        return [
          candidateRows.map((row) =>
            'owner_type' in row
              ? {
                  id: row['id'],
                  owner_type: row['owner_type'],
                  owner_user_id: row['owner_user_id'],
                  created_by: row['created_by']
                }
              : {
                  id: row['id'],
                  owner_type: 'PERSONAL',
                  owner_user_id: 7,
                  created_by: row['created_by'] ?? 7
                }
          ),
          metadata
        ];
      }
      return response;
    }
    if (sql.includes('LEFT JOIN system_settings model_settings')) {
      const queued = responses[0];
      const queuedHasModelRows =
        Array.isArray(queued) &&
        Array.isArray(queued[0]) &&
        queued[0].some(
          (row: unknown) =>
            typeof row === 'object' && row !== null && 'id' in row && 'protocol' in row
        );
      const response = queuedHasModelRows
        ? responses.shift()
        : candidateRows === undefined
          ? (responses.shift() ?? [[], []])
          : [candidateRows, []];
      if (
        Array.isArray(response) &&
        Array.isArray(response[0]) &&
        response[0].every((row: unknown) => typeof row === 'object' && row !== null)
      ) {
        const [allRows, metadata] = response as [readonly Record<string, unknown>[], unknown];
        const idList = sql.match(/\bmodel\.id\s+IN\s*\(([^)]*)\)/iu)?.[1];
        const ids =
          idList === undefined ? [] : values.slice(0, (idList.match(/\?/gu) ?? []).length);
        const selectedRows =
          ids.length > 0
            ? allRows.filter((row) => ids.includes(String(row['id'])))
            : /\bWHERE\s+model\.id\s*=\s*\?/iu.test(sql)
              ? allRows.filter((row) => String(row['id']) === String(values[0]))
              : allRows;
        const rows = selectedRows.filter(
          (row) =>
            (!sql.includes('model.enabled=1') ||
              row['enabled'] === undefined ||
              Boolean(row['enabled'])) &&
            (!sql.includes('model.conversation_model=1') ||
              row['conversation_model'] === undefined ||
              Boolean(row['conversation_model']))
        );
        for (const row of rows) {
          if (typeof row['id'] !== 'string' || typeof row['protocol'] !== 'string') continue;
          const key = `mar_agent_model_config:${row['id']}`;
          if (settings.has(key)) continue;
          const configured = Object.hasOwn(row, 'modelSettings')
            ? row['modelSettings']
            : row['model_settings'];
          if (configured === null) continue;
          const value =
            configured ??
            (row['protocol'] === 'ANTHROPIC_MESSAGES'
              ? { version: 1 }
              : { version: 1, hostedWebSearch: false, responsesPreviousResponseId: false });
          settings.set(key, typeof value === 'string' ? value : JSON.stringify(value));
        }
        return [
          rows.map((row) => {
            const key = `mar_agent_model_config:${String(row['id'])}`;
            const databaseRow = Object.fromEntries(
              Object.entries(row).filter(
                ([name]) => name !== 'modelSettings' && name !== 'model_settings'
              )
            );
            const joinedRow = { ...databaseRow, model_settings: settings.get(key) ?? null };
            return 'owner_type' in joinedRow
              ? joinedRow
              : {
                  ...joinedRow,
                  owner_type: 'PERSONAL',
                  owner_user_id: 7,
                  owner_organization_id: null
                };
          }),
          metadata
        ];
      }
      return response;
    }
    if (sql.includes('system_settings')) {
      if (sql.startsWith('SELECT'))
        return [
          [...settings]
            .filter(([key]) => values.includes(key))
            .map(([setting_key, setting_value]) => ({ setting_key, setting_value })),
          []
        ];
      if (sql.startsWith('INSERT')) settings.set(String(values[0]), String(values[1]));
      if (sql.startsWith('DELETE')) settings.delete(String(values[0]));
      return [{ affectedRows: 1 }];
    }
    const response = responses.shift() ?? [{ affectedRows: 1 }];
    if (
      Array.isArray(response) &&
      Array.isArray(response[0]) &&
      response[0].every((row: unknown) => typeof row === 'object' && row !== null)
    ) {
      const [rows, metadata] = response as [readonly Record<string, unknown>[], unknown];
      return [
        rows.map((row) => {
          const databaseRow = Object.fromEntries(
            Object.entries(row).filter(
              ([key]) => key !== 'modelSettings' && key !== 'model_settings'
            )
          );
          return 'owner_type' in databaseRow
            ? databaseRow
            : {
                ...databaseRow,
                owner_type: 'PERSONAL',
                owner_user_id: 7,
                owner_organization_id: null
              };
        }),
        metadata
      ];
    }
    return response;
  });
  const connectionExecute = vi.fn(async (...args: unknown[]) => {
    const sql = String(args[0]);
    const values = Array.isArray(args[1]) ? args[1] : [];
    if (sql.includes('SELECT id FROM users')) return [values.map((id) => ({ id })), []];
    if (sql.includes('SELECT id FROM mar_agent_models WHERE id=? FOR SHARE'))
      return [[{ id: values[0] }], []];
    if (
      sql.includes(
        'SELECT id,name,owner_type,owner_organization_id FROM mar_agent_models WHERE id=? FOR UPDATE'
      )
    )
      return [[{ id: values[0] }], []];
    if (sql.includes('SELECT id FROM mar_agent_models FOR UPDATE'))
      return [[{ sort_order: 0 }], []];
    return execute(...args);
  });
  const connection = {
    beginTransaction: vi.fn(async () => undefined),
    execute: connectionExecute,
    commit: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    release: vi.fn()
  };
  return {
    raw: { execute, getConnection: vi.fn(async () => connection) },
    connection
  } as unknown as MysqlServerDatabase & {
    raw: { execute: typeof execute };
    connection: typeof connection;
  };
}
function modelSettingsDocument(
  execute: { mock: { calls: readonly (readonly unknown[])[] } },
  modelId: string
): unknown {
  const write = execute.mock.calls.find(
    ([sql, parameters]) =>
      String(sql).startsWith('INSERT INTO system_settings') &&
      Array.isArray(parameters) &&
      parameters[0] === `mar_agent_model_config:${modelId}`
  );
  return write === undefined ? undefined : JSON.parse(String((write[1] as unknown[])[1]));
}
const input = {
  name: 'Coding',
  protocol: 'ANTHROPIC_MESSAGES',
  baseUrl: 'https://gateway.example.test',
  apiKey: 'secret',
  modelId: 'coding',
  contextWindowTokens: 200000,
  maxOutputTokens: 16384,
  inputCapabilities: ['TEXT', 'IMAGE'],
  outputCapabilities: ['TEXT'],
  reasoningEfforts: [],
  defaultReasoningEffort: 'medium',
  hostedWebSearch: false,
  enabled: true,
  sortOrder: 0
};
function modelServiceRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `Model ${id}`,
    protocol: 'ANTHROPIC_MESSAGES',
    base_url: input.baseUrl,
    credential: JSON.stringify({ type: 'INLINE_API_KEY', value: `${id}-secret` }),
    model_id: `upstream-${id}`,
    context_window_tokens: 128_000,
    max_output_tokens: 8_192,
    input_capabilities: '["TEXT"]',
    output_capabilities: '["TEXT"]',
    reasoning_efforts: '[]',
    default_reasoning_effort: 'medium',
    conversation_model: 1,
    title_generation: 0,
    code_mode: 0,
    enabled: 1,
    sort_order: 0,
    last_tested_at: null,
    last_test_status: 'UNVERIFIED',
    last_test_code: null,
    owner_type: 'PERSONAL',
    owner_user_id: 7,
    owner_organization_id: null,
    created_by: 7,
    public_access: 0,
    modelSettings: { version: 1 },
    ...overrides
  };
}
function importedCodexModelId(
  credentialId: string,
  upstreamModelId: string,
  ownership:
    | { ownerType: 'PERSONAL'; ownerUserId: number }
    | { ownerType: 'ORGANIZATION'; ownerOrganizationId: number } = {
    ownerType: 'PERSONAL',
    ownerUserId: 7
  }
) {
  return `codex-${createHash('sha256')
    .update(credentialId)
    .update('\0')
    .update(upstreamModelId)
    .update('\0')
    .update(
      ownership.ownerType === 'PERSONAL'
        ? `PERSONAL:${ownership.ownerUserId}`
        : `ORGANIZATION:${ownership.ownerOrganizationId}`
    )
    .digest()
    .subarray(0, 12)
    .toString('base64url')}`;
}
function managementAccess() {
  return {
    canUseModel: vi.fn(async () => true),
    canManageModel: vi.fn(async (_userId: number, _modelId: string) => true),
    assertOwnershipSelection: vi.fn(async () => undefined)
  };
}

describe('MAR Agent model service', () => {
  it.each([false, true])(
    'duplicates a model with a server-side key (replacement=%s)',
    async (replace) => {
      const db = database([
        [{ affectedRows: 1 }, []],
        [
          [
            {
              id: 'copy-id',
              name: 'Coding copy',
              protocol: 'ANTHROPIC_MESSAGES',
              base_url: input.baseUrl,
              model_id: input.modelId,
              credential: JSON.stringify({
                type: 'INLINE_API_KEY',
                value: replace ? 'replacement' : 'secret'
              }),
              context_window_tokens: input.contextWindowTokens,
              max_output_tokens: input.maxOutputTokens,
              input_capabilities: '["TEXT","IMAGE"]',
              output_capabilities: '["TEXT"]',
              reasoning_efforts: '[]',
              default_reasoning_effort: 'medium',
              title_generation: 1,
              code_mode: 1,
              enabled: 1,
              sort_order: 8,
              last_tested_at: null,
              last_test_status: 'UNVERIFIED',
              last_test_code: null,
              public_access: 0
            }
          ],
          []
        ]
      ]);
      const access = managementAccess();
      const service = new MarAgentModelService(
        db,
        () => 10,
        () => 'copy-id',
        access
      );
      const { apiKey: _sourceKey, sortOrder: _sourceOrder, ...sourceConfiguration } = input;
      const source = marAgentStoredModelConfigurationSchema.parse({
        ...sourceConfiguration,
        metadata: { useResourceUrl: true },
        id: 'source-id',
        credential: { type: 'INLINE_API_KEY', value: 'secret' }
      });
      vi.spyOn(service, 'stored').mockResolvedValue(source);
      const { apiKey: _apiKey, ...configuration } = input;
      const result = await service.duplicate(7, 'source-id', {
        ...configuration,
        name: 'Coding copy',
        titleGeneration: true,
        codeMode: true,
        sortOrder: 8,
        ...(replace ? { credential: { type: 'INLINE_API_KEY', value: 'replacement' } } : {})
      });
      expect(access.canManageModel).toHaveBeenCalledWith(7, 'source-id');
      expect(result).toMatchObject({
        id: 'copy-id',
        name: 'Coding copy',
        lastTestStatus: 'UNVERIFIED',
        lastTestedAt: null,
        access: 'RESTRICTED',
        ownership: { ownerType: 'PERSONAL', ownerUserId: 7 },
        titleGeneration: true,
        codeMode: true,
        metadata: { useResourceUrl: true },
        sortOrder: 8
      });
      const writes = db.raw.execute.mock.calls.filter(([sql]) =>
        String(sql).startsWith('INSERT INTO mar_agent_models')
      );
      expect(writes).toHaveLength(1);
      expect(String(writes[0]?.[0])).toContain('INSERT INTO mar_agent_models');
      expect(writes[0]?.[1]).toContain(
        JSON.stringify({
          type: 'INLINE_API_KEY',
          value: replace ? 'replacement' : 'secret'
        })
      );
      expect(JSON.stringify(result)).not.toContain('secret');
      expect(JSON.stringify(result)).not.toContain('replacement');
      expect(source.credential).toEqual({ type: 'INLINE_API_KEY', value: 'secret' });
    }
  );

  it('requires source management permission before reading or copying secrets', async () => {
    const db = database();
    const access = managementAccess();
    access.canManageModel.mockResolvedValue(false);
    const service = new MarAgentModelService(db, undefined, undefined, access);
    const stored = vi.spyOn(service, 'stored');
    await expect(service.duplicate(7, 'source-id', input)).rejects.toThrow(
      'MODEL_RESOURCE_ADMIN_REQUIRED'
    );
    expect(stored).not.toHaveBeenCalled();
    expect(db.raw.execute).not.toHaveBeenCalled();
  });

  it('fails without writing when the source has disappeared', async () => {
    const db = database([[[], []]]);
    const service = new MarAgentModelService(db, undefined, undefined, managementAccess());
    await expect(service.duplicate(7, 'missing-id', input)).rejects.toThrow(
      'MAR_AGENT_MODEL_NOT_FOUND'
    );
    expect(db.connection.beginTransaction).not.toHaveBeenCalled();
  });

  it('revalidates an inherited OAuth reference against the new model ownership', async () => {
    const db = database();
    const scopes = {
      assertModelCredentialBinding: vi.fn(async () => {
        throw new Error('CODEX_CREDENTIAL_SCOPE_CONFLICT');
      })
    };
    const service = new MarAgentModelService(db, undefined, undefined, managementAccess(), scopes);
    const credential = { type: 'CREDENTIAL_REF' as const, credentialId: 'team-credential' };
    const { apiKey: _sourceKey, sortOrder: _sourceOrder, ...sourceConfiguration } = input;
    vi.spyOn(service, 'stored').mockResolvedValue(
      marAgentStoredModelConfigurationSchema.parse({
        ...sourceConfiguration,
        id: 'source-id',
        protocol: 'OPENAI_RESPONSES',
        baseUrl: 'https://chatgpt.com/backend-api/codex',
        credential
      })
    );
    const { apiKey: _apiKey, ...configuration } = input;
    const ownership = { ownerType: 'ORGANIZATION', ownerOrganizationId: 2 };
    await expect(
      service.duplicate(7, 'source-id', {
        ...configuration,
        protocol: 'OPENAI_RESPONSES',
        baseUrl: 'https://chatgpt.com/backend-api/codex',
        ownership
      })
    ).rejects.toThrow('CODEX_CREDENTIAL_SCOPE_CONFLICT');
    expect(scopes.assertModelCredentialBinding).toHaveBeenCalledWith(
      7,
      'team-credential',
      undefined,
      ownership
    );
    expect(db.connection.beginTransaction).not.toHaveBeenCalled();
  });

  it('copies an OAuth reference through the existing creation checks, not its token', async () => {
    const db = database([
      [{ affectedRows: 1 }, []],
      [
        [
          {
            id: 'copy-id',
            name: 'OAuth copy',
            protocol: 'OPENAI_RESPONSES',
            base_url: 'https://chatgpt.com/backend-api/codex',
            model_id: 'coding',
            credential: JSON.stringify({ type: 'CREDENTIAL_REF', credentialId: 'team-credential' }),
            context_window_tokens: 200000,
            max_output_tokens: 16384,
            input_capabilities: '["TEXT"]',
            output_capabilities: '["TEXT"]',
            reasoning_efforts: '[]',
            default_reasoning_effort: 'medium',
            enabled: 1,
            sort_order: 1,
            last_test_status: 'UNVERIFIED',
            public_access: 0
          }
        ],
        []
      ]
    ]);
    const scopes = {
      assertModelCredentialBinding: vi.fn(async () => undefined),
      assertCredentialTarget: vi.fn(async () => undefined)
    };
    const service = new MarAgentModelService(
      db,
      () => 10,
      () => 'copy-id',
      managementAccess(),
      scopes
    );
    const { apiKey: _key, sortOrder: _sortOrder, ...configuration } = input;
    const credential = { type: 'CREDENTIAL_REF' as const, credentialId: 'team-credential' };
    const source = marAgentStoredModelConfigurationSchema.parse({
      ...configuration,
      id: 'source-id',
      protocol: 'OPENAI_RESPONSES',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      credential
    });
    vi.spyOn(service, 'stored').mockResolvedValue(source);
    const result = await service.duplicate(7, source.id, {
      ...source,
      name: 'OAuth copy',
      credential: undefined,
      sortOrder: 1
    });
    expect(result).toMatchObject({
      id: 'copy-id',
      credentialType: 'CREDENTIAL_REF',
      lastTestStatus: 'UNVERIFIED'
    });
    expect(result).not.toHaveProperty('credential');
    expect(scopes.assertModelCredentialBinding).toHaveBeenCalledWith(
      7,
      'team-credential',
      undefined,
      {
        ownerType: 'PERSONAL',
        ownerUserId: 7
      }
    );
    expect(scopes.assertCredentialTarget).toHaveBeenCalledWith(
      7,
      'team-credential',
      source.baseUrl
    );
    const insert = db.raw.execute.mock.calls.find(([sql]) =>
      String(sql).startsWith('INSERT INTO mar_agent_models')
    );
    expect(insert?.[1]).toContain(JSON.stringify(credential));
    const callsBeforeInvalidDuplicate = db.raw.execute.mock.calls.length;
    await expect(service.duplicate(7, source.id, { ...configuration })).rejects.toThrow(
      'MAR_AGENT_MODEL_CONFIG_INVALID'
    );
    expect(db.raw.execute.mock.calls).toHaveLength(callsBeforeInvalidDuplicate);
  });

  it.each(
    [true, false].flatMap((hostedWebSearch) => [
      ...[true, false].map((responsesPreviousResponseId) => ({
        hostedWebSearch,
        responsesPreviousResponseId,
        responsesTransport: { transport: 'HTTP' as const, httpVersion: '1.1' as const }
      })),
      ...[true, false].map((responsesPreviousResponseId) => ({
        hostedWebSearch,
        responsesPreviousResponseId,
        responsesTransport: { transport: 'WEBSOCKET' as const }
      }))
    ])
  )(
    'persists and reads X subscription search $hostedWebSearch and continuation $responsesPreviousResponseId over $responsesTransport.transport',
    async ({ hostedWebSearch, responsesTransport, responsesPreviousResponseId }) => {
      const row = {
        ...Object.fromEntries(
          Object.entries(input)
            .filter(([key]) => key !== 'apiKey' && key !== 'hostedWebSearch')
            .map(([key, value]) => [
              key.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`),
              Array.isArray(value) ? JSON.stringify(value) : value
            ])
        ),
        id: 'grok-id',
        protocol: 'OPENAI_RESPONSES',
        base_url: 'https://cli-chat-proxy.grok.com/v1',
        credential: JSON.stringify({ type: 'CREDENTIAL_REF', credentialId: 'grok-credential' }),
        modelSettings: {
          version: 1,
          hostedWebSearch: !hostedWebSearch,
          serviceTier: 'default',
          responsesTransport,
          responsesPreviousResponseId: false
        }
      };
      const updatedRow = {
        ...row,
        modelSettings: {
          version: 1,
          hostedWebSearch,
          serviceTier: 'default',
          responsesTransport,
          responsesPreviousResponseId
        }
      };
      const db = database([
        [[row], []],
        [[row], []],
        [[{ sort_order: 0 }], []],
        [{ affectedRows: 1 }, []],
        [[updatedRow], []],
        [[updatedRow], []]
      ]);
      const service = new CoreMarAgentModelService(db, Date.now, undefined, managementAccess(), {
        assertModelCredentialBinding: vi.fn()
      });
      expect(
        await service.update(7, 'grok-id', { hostedWebSearch, responsesPreviousResponseId })
      ).toMatchObject({
        hostedWebSearch,
        responsesPreviousResponseId
      });
      expect(modelSettingsDocument(db.raw.execute, 'grok-id')).toEqual({
        version: 1,
        hostedWebSearch,
        serviceTier: 'default',
        responsesTransport,
        responsesPreviousResponseId
      });
      expect(await service.stored('grok-id')).toMatchObject({
        hostedWebSearch,
        responsesTransport,
        responsesPreviousResponseId
      });
    }
  );

  it.each([
    { responsesTransport: { transport: 'WEBSOCKET' }, serviceTier: 'priority' },
    { responsesTransport: { transport: 'HTTP', httpVersion: '2' } },
    { baseUrl: 'https://api.x.ai/v1' }
  ])('rejects unsupported X subscription settings before writing: %j', async (settings) => {
    const db = database();
    const service = new CoreMarAgentModelService(db, Date.now, undefined, managementAccess(), {
      assertModelCredentialBinding: vi.fn()
    });
    await expect(
      service.create(7, {
        ...input,
        protocol: 'OPENAI_RESPONSES',
        baseUrl: 'https://cli-chat-proxy.grok.com/v1',
        credential: { type: 'CREDENTIAL_REF', credentialId: 'xai-credential' },
        ...settings
      })
    ).rejects.toThrow('MAR_AGENT_MODEL_CONFIG_INVALID');
    expect(db.raw.execute).not.toHaveBeenCalled();
  });

  it.each(
    [
      'https://chatgpt.com/backend-api/codex',
      'https://api.openai.com/v1',
      'https://cli-chat-proxy.grok.com/v1'
    ].flatMap((baseUrl) =>
      (baseUrl === 'https://cli-chat-proxy.grok.com/v1' ? ['1.1'] : ['1.1', '2']).map(
        (httpVersion) => ({
          baseUrl,
          httpVersion
        })
      )
    )
  )(
    'persists HTTP continuation for $baseUrl HTTP/$httpVersion',
    async ({ baseUrl, httpVersion }) => {
      const row = {
        ...Object.fromEntries(
          Object.entries(input)
            .filter(([key]) => key !== 'apiKey' && key !== 'hostedWebSearch')
            .map(([key, value]) => [
              key.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`),
              Array.isArray(value) ? JSON.stringify(value) : value
            ])
        ),
        id: 'http-model',
        protocol: 'OPENAI_RESPONSES',
        base_url: baseUrl,
        credential: JSON.stringify({ type: 'CREDENTIAL_REF', credentialId: 'credential-1' })
      };
      const db = database([
        [{ affectedRows: 1 }, []],
        [[row], []]
      ]);
      const service = new CoreMarAgentModelService(
        db,
        Date.now,
        () => 'http-model',
        managementAccess(),
        {
          assertModelCredentialBinding: vi.fn(),
          assertCredentialTarget: vi.fn(),
          assertStoredCredentialTarget: vi.fn()
        }
      );
      await expect(
        service.create(7, {
          ...input,
          protocol: 'OPENAI_RESPONSES',
          baseUrl,
          credential: { type: 'CREDENTIAL_REF', credentialId: 'credential-1' },
          responsesTransport: { transport: 'HTTP', httpVersion },
          responsesPreviousResponseId: true
        })
      ).resolves.toMatchObject({
        responsesPreviousResponseId: true,
        responsesTransport: { transport: 'HTTP', httpVersion }
      });
      const insert = db.raw.execute.mock.calls.find(([sql]) =>
        String(sql).startsWith('INSERT INTO mar_agent_models')
      )!;
      expect(modelSettingsDocument(db.raw.execute, 'http-model')).toEqual({
        version: 1,
        hostedWebSearch: false,
        responsesTransport: { transport: 'HTTP', httpVersion },
        responsesPreviousResponseId: true
      });
      expect(String(insert[0])).not.toContain('responses_transport');
      expect(String(insert[0])).not.toContain('responses_previous_response_id');
      expect(String(insert[0]).match(/\?/gu)).toHaveLength((insert[1] as unknown[]).length);
    }
  );

  it('ignores the retired high-density database value in enterprise model summaries', async () => {
    const db = database([
      [
        [
          {
            id: 'coding-id',
            name: 'Coding',
            protocol: 'ANTHROPIC_MESSAGES',
            base_url: 'https://gateway.example.test',
            model_id: 'coding',
            context_window_tokens: 200000,
            max_output_tokens: 16384,
            input_capabilities: '["TEXT"]',
            output_capabilities: '["TEXT"]',
            reasoning_efforts: '[]',
            default_reasoning_effort: 'medium',
            title_generation: 0,
            code_mode: 0,
            high_density_compaction: 1,
            enabled: 1,
            sort_order: 0,
            last_tested_at: null,
            last_test_status: 'UNVERIFIED',
            last_test_code: null,
            public_access: 0
          }
        ],
        []
      ]
    ]);
    const service = new MarAgentModelService(db, Date.now, undefined, managementAccess());

    const summaries = await service.list();
    expect(summaries).toEqual([expect.objectContaining({ id: 'coding-id' })]);
    expect(summaries[0]).not.toHaveProperty('highDensityCompaction');
    const modelQuery = db.raw.execute.mock.calls.find(([sql]) =>
      String(sql).includes('FROM mar_agent_models')
    );
    expect(String(modelQuery?.[0])).not.toContain('high_density_compaction');
  });

  it('creates an independent connection and never returns its key', async () => {
    const db = database([
      [{ affectedRows: 1 }, []],
      [
        [
          {
            id: 'coding-id',
            name: 'Coding',
            protocol: 'ANTHROPIC_MESSAGES',
            base_url: 'https://gateway.example.test',
            model_id: 'coding',
            context_window_tokens: 200000,
            max_output_tokens: 16384,
            input_capabilities: '["TEXT","IMAGE"]',
            output_capabilities: '["TEXT"]',
            reasoning_efforts: '[]',
            default_reasoning_effort: 'medium',
            conversation_model: 0,
            enabled: 1,
            sort_order: 0,
            last_tested_at: null,
            last_test_status: 'UNVERIFIED',
            last_test_code: null,
            public_access: 0
          }
        ],
        []
      ]
    ]);
    const service = new MarAgentModelService(
      db,
      () => 10,
      () => 'coding-id'
    );
    const result = await service.create(7, { ...input, conversationModel: false });
    expect(result).toMatchObject({
      id: 'coding-id',
      conversationModel: false,
      apiKeyConfigured: true,
      sortOrder: 0,
      access: 'RESTRICTED',
      ownership: { ownerType: 'PERSONAL', ownerUserId: 7 },
      defaultReasoningEffort: 'medium'
    });
    const insert = db.raw.execute.mock.calls.find(([sql]) =>
      String(sql).startsWith('INSERT INTO mar_agent_models')
    )!;
    expect((insert[1] as unknown[])[13]).toBe(false);
    expect(String(insert[0])).toContain('default_reasoning_effort');
    expect(insert[1]).toContain('medium');
    expect(insert[1]).toContain('PERSONAL');
    expect(insert[1]).toContain(7);
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('generates a compact model configuration ID by default', async () => {
    let generatedId = '';
    const settings = new Map<string, string>();
    const execute = vi.fn(async (sql: unknown, parameters?: readonly unknown[]) => {
      const statement = String(sql);
      const values = Array.isArray(parameters) ? parameters : [];
      if (statement.includes('LEFT JOIN system_settings model_settings'))
        return [
          [
            {
              id: generatedId,
              name: 'Coding',
              protocol: 'ANTHROPIC_MESSAGES',
              base_url: 'https://gateway.example.test',
              model_id: 'coding',
              context_window_tokens: 200000,
              max_output_tokens: 16384,
              input_capabilities: '["TEXT","IMAGE"]',
              output_capabilities: '["TEXT"]',
              reasoning_efforts: '[]',
              default_reasoning_effort: 'medium',
              enabled: 1,
              sort_order: 0,
              last_tested_at: null,
              last_test_status: 'UNVERIFIED',
              last_test_code: null,
              public_access: 0,
              model_settings: settings.get(`mar_agent_model_config:${generatedId}`) ?? null
            }
          ],
          []
        ] as never;
      if (statement.includes('system_settings')) {
        if (statement.startsWith('SELECT'))
          return [
            [...settings]
              .filter(([key]) => values.includes(key))
              .map(([setting_key, setting_value]) => ({ setting_key, setting_value })),
            []
          ] as never;
        if (statement.startsWith('INSERT')) settings.set(String(values[0]), String(values[1]));
        return [{ affectedRows: 1 }, []] as never;
      }
      if (statement.startsWith('INSERT INTO mar_agent_models')) {
        generatedId = String(parameters?.[0]);
        return [{ affectedRows: 1 }, []] as never;
      }
      return [
        [
          {
            id: generatedId,
            name: 'Coding',
            protocol: 'ANTHROPIC_MESSAGES',
            base_url: 'https://gateway.example.test',
            model_id: 'coding',
            context_window_tokens: 200000,
            max_output_tokens: 16384,
            input_capabilities: '["TEXT","IMAGE"]',
            output_capabilities: '["TEXT"]',
            reasoning_efforts: '[]',
            default_reasoning_effort: 'medium',
            enabled: 1,
            sort_order: 0,
            last_tested_at: null,
            last_test_status: 'UNVERIFIED',
            last_test_code: null,
            public_access: 0
          }
        ],
        []
      ] as never;
    });
    const connectionExecute = vi.fn(async (sql: unknown, parameters?: readonly unknown[]) => {
      if (String(sql).includes('SELECT id FROM users'))
        return [[{ id: parameters?.[0] }], []] as never;
      return execute(sql, parameters);
    });
    const connection = {
      beginTransaction: vi.fn(async () => undefined),
      execute: connectionExecute,
      commit: vi.fn(async () => undefined),
      rollback: vi.fn(async () => undefined),
      release: vi.fn()
    };
    const service = new MarAgentModelService({
      raw: { execute, getConnection: vi.fn(async () => connection) }
    } as unknown as MysqlServerDatabase);

    const result = await service.create(7, input);
    expect(result).toMatchObject({ id: generatedId });
    expect(generatedId).toMatch(/^model-[A-Za-z0-9_-]{16}$/u);
  });

  it('rejects unsafe URLs and invalid capability declarations', async () => {
    const service = new MarAgentModelService(database());
    await expect(service.create(7, { ...input, baseUrl: 'http://example.test' })).rejects.toThrow(
      'MAR_AGENT_MODEL_CONFIG_INVALID'
    );
    await expect(service.create(7, { ...input, inputCapabilities: ['IMAGE'] })).rejects.toThrow(
      'MAR_AGENT_MODEL_CONFIG_INVALID'
    );
    await expect(
      service.create(7, { ...input, responsesPreviousResponseId: true })
    ).rejects.toThrow('MAR_AGENT_MODEL_CONFIG_INVALID');
    await expect(
      service.create(7, {
        ...input,
        reasoningEfforts: ['high'],
        defaultReasoningEffort: 'medium'
      })
    ).rejects.toThrow('MAR_AGENT_MODEL_CONFIG_INVALID');
    await expect(
      service.create(7, {
        ...input,
        protocol: 'OPENAI_RESPONSES',
        baseUrl: 'https://collector.example.test/codex',
        credential: { type: 'CREDENTIAL_REF', credentialId: 'credential-1' },
        responsesTransport: { transport: 'WEBSOCKET' }
      })
    ).rejects.toThrow('MAR_AGENT_MODEL_CONFIG_INVALID');
  });

  it('rejects the retired fastMode input before writing', async () => {
    const db = database();
    const service = new MarAgentModelService(db);
    await expect(service.create(7, { ...input, fastMode: true })).rejects.toThrow(
      'MAR_AGENT_MODEL_CONFIG_INVALID'
    );
    expect(db.raw.execute).not.toHaveBeenCalled();
  });

  it('rejects missing or unmanageable Codex credential references before model persistence', async () => {
    const responses: unknown[] = [];
    const db = database(responses);
    const credentials = {
      assertModelCredentialBinding: vi
        .fn()
        .mockRejectedValueOnce(new Error('CODEX_CREDENTIAL_NOT_FOUND'))
        .mockRejectedValueOnce(new Error('CODEX_CREDENTIAL_NOT_FOUND'))
    };
    const service = new MarAgentModelService(
      db,
      () => 10,
      () => 'codex-id',
      managementAccess(),
      credentials
    );
    const codexInput = {
      ...input,
      apiKey: undefined,
      protocol: 'OPENAI_RESPONSES',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      credential: { type: 'CREDENTIAL_REF', credentialId: 'credential-missing' },
      responsesTransport: { transport: 'WEBSOCKET' }
    };

    await expect(service.create(7, codexInput)).rejects.toThrow('CODEX_CREDENTIAL_NOT_FOUND');
    expect(credentials.assertModelCredentialBinding).toHaveBeenCalledWith(
      7,
      'credential-missing',
      undefined,
      { ownerType: 'PERSONAL', ownerUserId: 7 }
    );
    expect(db.raw.execute).not.toHaveBeenCalled();

    const stored = {
      id: 'codex-id',
      name: 'Codex',
      protocol: 'OPENAI_RESPONSES',
      base_url: 'https://chatgpt.com/backend-api/codex',
      credential: JSON.stringify({
        type: 'CREDENTIAL_REF',
        credentialId: 'credential-existing'
      }),
      model_id: 'gpt-codex',
      context_window_tokens: 200_000,
      max_output_tokens: 16_384,
      input_capabilities: '["TEXT"]',
      output_capabilities: '["TEXT"]',
      reasoning_efforts: '["high"]',
      modelSettings: {
        version: 1,
        hostedWebSearch: true,
        serviceTier: 'default',
        responsesTransport: { transport: 'WEBSOCKET' },
        responsesPreviousResponseId: true
      },
      enabled: 1,
      sort_order: 0,
      owner_type: 'PERSONAL',
      owner_user_id: 7,
      owner_organization_id: null
    };
    responses.push([[stored], []], [[stored], []], [[{ sort_order: 0 }], []]);
    await expect(
      service.update(7, 'codex-id', {
        credential: { type: 'CREDENTIAL_REF', credentialId: 'credential-private' }
      })
    ).rejects.toThrow('CODEX_CREDENTIAL_NOT_FOUND');
    expect(credentials.assertModelCredentialBinding).toHaveBeenLastCalledWith(
      7,
      'credential-private',
      'codex-id',
      { ownerType: 'PERSONAL', ownerUserId: 7 }
    );
  });

  it.each([undefined, { ownerType: 'ORGANIZATION' as const, ownerOrganizationId: 12 }])(
    'rechecks the target credential with the selected import ownership %j',
    async (ownership) => {
      const credentials = {
        assertModelCredentialBinding: vi
          .fn()
          .mockRejectedValue(new Error('CODEX_CREDENTIAL_NOT_FOUND'))
      };
      const service = new MarAgentModelService(
        { raw: { getConnection: vi.fn() } } as never,
        Date.now,
        undefined,
        {
          canUseModel: vi.fn().mockResolvedValue(true),
          canManageModel: vi.fn().mockResolvedValue(true),
          assertOwnershipSelection: vi.fn()
        },
        credentials
      );
      const catalog: CodexModelCatalog = {
        catalogHash: 'f'.repeat(64),
        fetchedAt: 10,
        models: [
          {
            upstreamModelId: 'gpt-codex',
            displayName: 'GPT Codex',
            contextWindowTokens: 200_000,
            maxOutputTokens: 16_000,
            reasoningEfforts: ['high'],
            unsupportedReasoningEfforts: [],
            inputCapabilities: ['TEXT'],
            hostedWebSearch: true,
            warnings: [],
            requiredInputs: []
          }
        ]
      };

      await expect(
        service.importCodexModels(7, 'credential-private', catalog, {
          catalogHash: catalog.catalogHash,
          ...(ownership ? { ownership } : {}),
          models: [{ upstreamModelId: 'gpt-codex', enabled: true }]
        })
      ).rejects.toThrow('CODEX_CREDENTIAL_NOT_FOUND');
      expect(credentials.assertModelCredentialBinding).toHaveBeenCalledWith(
        7,
        'credential-private',
        undefined,
        ownership ?? { ownerType: 'PERSONAL', ownerUserId: 7 }
      );
    }
  );

  it.each([
    'https://api.openai.com/v1',
    'https://api.x.ai/v1',
    'https://cli-chat-proxy.grok.com/v1'
  ])(
    'persists transport and generic Responses parameters for inline API keys at %s',
    async (baseUrl) => {
      const row = {
        id: 'responses-id',
        name: 'Responses',
        normalized_name: 'responses',
        protocol: 'OPENAI_RESPONSES',
        base_url: baseUrl,
        credential: JSON.stringify({ type: 'INLINE_API_KEY', value: 'secret' }),
        model_id: 'gpt-responses',
        context_window_tokens: 200_000,
        max_output_tokens: 16_384,
        input_capabilities: '["TEXT"]',
        output_capabilities: '["TEXT"]',
        reasoning_efforts: '[]',
        modelSettings: {
          version: 1,
          hostedWebSearch: false,
          serviceTier: 'auto',
          responsesTransport: { transport: 'WEBSOCKET' },
          responsesPreviousResponseId: true
        },
        enabled: 1,
        sort_order: 0,
        last_tested_at: null,
        last_test_status: 'UNVERIFIED',
        last_test_code: null,
        public_access: 0
      };
      const createDatabase = database([
        [{ affectedRows: 1 }, []],
        [[row], []]
      ]);
      const createService = new MarAgentModelService(
        createDatabase,
        () => 10,
        () => 'responses-id'
      );

      await expect(
        createService.create(7, {
          ...input,
          protocol: 'OPENAI_RESPONSES',
          baseUrl,
          credential: { type: 'INLINE_API_KEY', value: 'secret' },
          responsesTransport: { transport: 'WEBSOCKET' },
          responsesPreviousResponseId: true,
          serviceTier: 'auto'
        })
      ).resolves.toMatchObject({
        responsesTransport: { transport: 'WEBSOCKET' },
        responsesPreviousResponseId: true,
        serviceTier: 'auto'
      });
      const createInsert = createDatabase.raw.execute.mock.calls.find(([sql]) =>
        String(sql).startsWith('INSERT INTO mar_agent_models')
      )!;
      expect(modelSettingsDocument(createDatabase.raw.execute, 'responses-id')).toEqual({
        version: 1,
        hostedWebSearch: false,
        serviceTier: 'auto',
        responsesTransport: { transport: 'WEBSOCKET' },
        responsesPreviousResponseId: true
      });
      expect(String(createInsert[0])).not.toContain('service_tier');
      expect(String(createInsert[0])).not.toContain('responses_transport');

      const updateDatabase = database([
        [[row], []],
        [[row], []],
        [[{ sort_order: 0 }], []],
        [{ affectedRows: 1 }, []],
        [[row], []]
      ]);
      const updateService = new MarAgentModelService(
        updateDatabase,
        Date.now,
        undefined,
        managementAccess()
      );

      await expect(
        updateService.update(7, 'responses-id', {
          responsesTransport: { transport: 'HTTP', httpVersion: '2' },
          serviceTier: 'auto'
        })
      ).resolves.toMatchObject({
        responsesTransport: { transport: 'HTTP', httpVersion: '2' },
        responsesPreviousResponseId: true
      });
      const update = updateDatabase.raw.execute.mock.calls.find(([sql]) =>
        String(sql).startsWith('UPDATE mar_agent_models')
      )!;
      expect(modelSettingsDocument(updateDatabase.raw.execute, 'responses-id')).toEqual({
        version: 1,
        hostedWebSearch: false,
        serviceTier: 'auto',
        responsesTransport: { transport: 'HTTP', httpVersion: '2' },
        responsesPreviousResponseId: true
      });
      expect(String(createInsert[0])).not.toContain('responses_encoding');
      expect(String(update[0])).not.toContain('responses_encoding');
    }
  );

  it('preserves stored Responses transport when Codex switches to an inline API key', async () => {
    const storedRow = {
      id: 'codex-id',
      name: 'Codex',
      protocol: 'OPENAI_RESPONSES',
      base_url: 'https://chatgpt.com/backend-api/codex',
      credential: JSON.stringify({
        type: 'CREDENTIAL_REF',
        credentialId: 'credential-1'
      }),
      model_id: 'gpt-codex',
      context_window_tokens: 200_000,
      max_output_tokens: 16_384,
      input_capabilities: '["TEXT"]',
      output_capabilities: '["TEXT"]',
      reasoning_efforts: '["high"]',
      conversation_model: 0,
      modelSettings: {
        version: 1,
        hostedWebSearch: true,
        serviceTier: 'default',
        responsesTransport: { transport: 'WEBSOCKET' },
        responsesPreviousResponseId: true
      },
      enabled: 1,
      sort_order: 0,
      last_tested_at: null,
      last_test_status: 'UNVERIFIED',
      last_test_code: null,
      public_access: 0
    };
    const updatedRow = {
      ...storedRow,
      base_url: 'https://api.openai.com/v1',
      credential: JSON.stringify({ type: 'INLINE_API_KEY', value: 'secret' })
    };
    const db = database([
      [[storedRow], []],
      [[storedRow], []],
      [[{ sort_order: 0 }], []],
      [{ affectedRows: 1 }, []],
      [[updatedRow], []]
    ]);
    const service = new MarAgentModelService(db, Date.now, undefined, managementAccess());

    await expect(
      service.update(7, 'codex-id', {
        baseUrl: 'https://api.openai.com/v1',
        credential: { type: 'INLINE_API_KEY', value: 'secret' }
      })
    ).resolves.toMatchObject({
      conversationModel: false,
      credentialType: 'INLINE_API_KEY'
    });

    expect(modelSettingsDocument(db.raw.execute, 'codex-id')).toEqual({
      version: 1,
      hostedWebSearch: true,
      serviceTier: 'default',
      responsesTransport: { transport: 'WEBSOCKET' },
      responsesPreviousResponseId: true
    });
    expect(
      (
        db.raw.execute.mock.calls.find(([sql]) =>
          String(sql).startsWith('UPDATE mar_agent_models')
        )?.[1] as unknown[]
      )[12]
    ).toBe(false);
    expect(
      String(
        db.raw.execute.mock.calls.find(([sql]) =>
          String(sql).startsWith('UPDATE mar_agent_models')
        )?.[0]
      )
    ).not.toContain('responses_encoding');
  });

  it('reads persisted Responses transport with an inline API key', async () => {
    const row = {
      id: 'responses-id',
      name: 'Responses',
      protocol: 'OPENAI_RESPONSES',
      base_url: 'https://api.openai.com/v1',
      credential: JSON.stringify({ type: 'INLINE_API_KEY', value: 'secret' }),
      model_id: 'gpt-responses',
      context_window_tokens: 200_000,
      max_output_tokens: 16_384,
      input_capabilities: '["TEXT"]',
      output_capabilities: '["TEXT"]',
      reasoning_efforts: '[]',
      modelSettings: {
        version: 1,
        hostedWebSearch: false,
        responsesTransport: { transport: 'WEBSOCKET' },
        responsesPreviousResponseId: false
      },
      enabled: 1,
      sort_order: 0,
      last_tested_at: null,
      last_test_status: 'UNVERIFIED',
      last_test_code: null,
      public_access: 0
    };
    const listService = new MarAgentModelService(database([[[row], []]]));
    const storedService = new MarAgentModelService(database([[[row], []]]));
    await expect(listService.list()).resolves.toMatchObject([
      { responsesTransport: { transport: 'WEBSOCKET' } }
    ]);
    await expect(storedService.stored('responses-id')).resolves.toMatchObject({
      responsesTransport: { transport: 'WEBSOCKET' }
    });
  });

  it('fails closed for an invalid persisted default reasoning effort', async () => {
    const row = {
      id: 'coding-id',
      name: 'Coding',
      protocol: 'ANTHROPIC_MESSAGES',
      base_url: 'https://gateway.example.test',
      credential: JSON.stringify({ type: 'INLINE_API_KEY', value: 'secret' }),
      model_id: 'coding',
      context_window_tokens: 200_000,
      max_output_tokens: 16_384,
      input_capabilities: '["TEXT"]',
      output_capabilities: '["TEXT"]',
      reasoning_efforts: '["low","high"]',
      default_reasoning_effort: 'medium',
      enabled: 1,
      sort_order: 0,
      last_tested_at: null,
      last_test_status: 'UNVERIFIED',
      last_test_code: null,
      public_access: 0
    };

    await expect(new MarAgentModelService(database([[[row], []]])).list()).rejects.toThrow(
      'MAR_AGENT_MODEL_CONFIG_INVALID'
    );
    await expect(
      new MarAgentModelService(database([[[row], []]])).stored('coding-id')
    ).rejects.toThrow('MAR_AGENT_MODEL_CONFIG_INVALID');
  });

  it('returns an exact runtime contract without summary-only fields', async () => {
    const service = new MarAgentModelService(
      database([
        [
          [
            {
              id: 'coding-id',
              ...Object.fromEntries(
                Object.entries(input)
                  .filter(([key]) => key !== 'apiKey' && key !== 'hostedWebSearch')
                  .map(([key, value]) => [
                    key.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`),
                    Array.isArray(value) ? JSON.stringify(value) : value
                  ])
              ),
              api_key: 'secret'
            }
          ],
          []
        ]
      ])
    );
    const result = await service.runtime('coding-id');
    expect(result.apiKey).toBe('secret');
    expect(result).not.toHaveProperty('apiKeyConfigured');
    expect(result).not.toHaveProperty('sortOrder');
    expect(result).not.toHaveProperty('access');
  });

  it('persists Codex model configuration without Responses encoding', async () => {
    const db = database([
      [{ affectedRows: 1 }, []],
      [
        [
          {
            id: 'codex-id',
            name: 'Codex',
            protocol: 'OPENAI_RESPONSES',
            base_url: 'https://chatgpt.com/backend-api/codex',
            credential: JSON.stringify({
              type: 'CREDENTIAL_REF',
              credentialId: 'credential-1'
            }),
            model_id: 'gpt-codex',
            context_window_tokens: 200000,
            max_output_tokens: 32000,
            input_capabilities: '["TEXT","IMAGE"]',
            output_capabilities: '["TEXT"]',
            reasoning_efforts: '["low","high"]',
            default_reasoning_effort: 'high',
            enabled: 1,
            sort_order: 0,
            last_tested_at: null,
            last_test_status: 'UNVERIFIED',
            last_test_code: null,
            public_access: 0
          }
        ],
        []
      ]
    ]);
    const service = new MarAgentModelService(
      db,
      () => 10,
      () => 'codex-id',
      undefined,
      { assertModelCredentialBinding: vi.fn() }
    );

    const result = await service.create(7, {
      name: 'Codex',
      protocol: 'OPENAI_RESPONSES',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      credential: { type: 'CREDENTIAL_REF', credentialId: 'credential-1' },
      modelId: 'gpt-codex',
      contextWindowTokens: 200000,
      maxOutputTokens: 32000,
      inputCapabilities: ['TEXT', 'IMAGE'],
      outputCapabilities: ['TEXT'],
      reasoningEfforts: ['low', 'high'],
      defaultReasoningEffort: 'high',
      hostedWebSearch: true,
      responsesTransport: { transport: 'WEBSOCKET' },
      serviceTier: 'priority',
      responsesPreviousResponseId: true,
      enabled: true,
      sortOrder: 0
    });

    const insert = db.raw.execute.mock.calls.find(([sql]) =>
      String(sql).startsWith('INSERT INTO mar_agent_models')
    )!;
    const [sql, params] = insert;
    expect(String(sql)).not.toContain('responses_encoding');
    expect(params).not.toContain('STANDARD');
    expect(String(sql)).toContain('credential');
    expect(String(sql)).not.toContain('fast_mode');
    expect(String(sql)).not.toContain('service_tier');
    expect(String(sql)).not.toContain('hosted_web_search');
    expect(String(sql)).not.toContain('responses_transport');
    expect(String(sql)).not.toContain('responses_previous_response_id');
    expect(String(sql)).not.toContain('api_key');
    expect(params).toContain(
      JSON.stringify({ type: 'CREDENTIAL_REF', credentialId: 'credential-1' })
    );
    expect(result).toMatchObject({
      id: 'codex-id',
      credentialType: 'CREDENTIAL_REF',
      credentialConfigured: true,
      responsesTransport: { transport: 'WEBSOCKET' },
      serviceTier: 'priority',
      hostedWebSearch: true,
      responsesPreviousResponseId: true
    });
    expect(modelSettingsDocument(db.raw.execute, 'codex-id')).toEqual({
      version: 1,
      hostedWebSearch: true,
      serviceTier: 'priority',
      responsesTransport: { transport: 'WEBSOCKET' },
      responsesPreviousResponseId: true
    });
    expect(result).not.toHaveProperty('responsesEncoding');
    expect(JSON.stringify(result)).not.toContain('credential-1');
  });

  it('fails closed when a stored Codex credential reference points outside the fixed backend', async () => {
    const service = new MarAgentModelService(
      database([
        [
          [
            {
              id: 'codex-id',
              name: 'Codex',
              protocol: 'OPENAI_RESPONSES',
              base_url: 'https://collector.example.test/codex',
              credential: JSON.stringify({
                type: 'CREDENTIAL_REF',
                credentialId: 'credential-1'
              }),
              model_id: 'gpt-codex',
              context_window_tokens: 200000,
              max_output_tokens: 16384,
              input_capabilities: '["TEXT"]',
              output_capabilities: '["TEXT"]',
              reasoning_efforts: '["high"]',
              enabled: 1
            }
          ],
          []
        ]
      ])
    );

    await expect(service.stored('codex-id')).rejects.toThrow('MAR_AGENT_MODEL_CONFIG_INVALID');
  });

  it('ignores missing settings for unauthorized models but fails closed for authorized models', async () => {
    const authorizedRow = {
      id: 'authorized-model',
      name: 'Authorized',
      protocol: 'OPENAI_RESPONSES',
      base_url: 'https://api.example.test/v1',
      credential: JSON.stringify({ type: 'INLINE_API_KEY', value: 'secret' }),
      model_id: 'authorized',
      context_window_tokens: 128_000,
      max_output_tokens: 8_192,
      input_capabilities: '["TEXT"]',
      output_capabilities: '["TEXT"]',
      reasoning_efforts: '["medium"]',
      default_reasoning_effort: 'medium',
      enabled: 1,
      sort_order: 0,
      modelSettings: {
        version: 1,
        hostedWebSearch: false,
        responsesPreviousResponseId: false
      }
    };
    const unauthorizedRow = {
      ...authorizedRow,
      id: 'unauthorized-model',
      name: 'Unauthorized',
      modelSettings: null
    };
    const db = database([[[authorizedRow, unauthorizedRow], []]]);
    const access = {
      ...managementAccess(),
      canUseModel: vi.fn(async (_userId: number, modelId: string) => modelId === 'authorized-model')
    };
    const service = new MarAgentModelService(db, Date.now, undefined, access);

    await expect(service.storedConfigurationsForUser(8)).resolves.toEqual([
      expect.objectContaining({ id: 'authorized-model', modelId: 'authorized' })
    ]);
    expect(access.canUseModel).toHaveBeenCalledWith(8, 'unauthorized-model');
    const settingsJoin = db.raw.execute.mock.calls.find(([sql]) =>
      String(sql).includes('LEFT JOIN system_settings model_settings')
    );
    expect(settingsJoin?.[1]).toEqual(['authorized-model']);
    expect(
      db.raw.execute.mock.calls.some(
        ([sql]) =>
          String(sql).startsWith('SELECT id,owner_type,owner_user_id,created_by') &&
          String(sql).includes('system_settings')
      )
    ).toBe(false);

    const missingAuthorizedDb = database([[[{ ...authorizedRow, modelSettings: null }], []]]);
    const authorizedAccess = {
      ...managementAccess(),
      canUseModel: vi.fn(async () => true)
    };
    const missingAuthorizedService = new MarAgentModelService(
      missingAuthorizedDb,
      Date.now,
      undefined,
      authorizedAccess
    );
    await expect(missingAuthorizedService.storedConfigurationsForUser(8)).rejects.toThrow(
      'MAR_AGENT_MODEL_CONFIG_INVALID'
    );
  });

  it('joins model settings only for models the user can manage', async () => {
    const managedRow = modelServiceRow('managed-model');
    const inaccessibleRow = modelServiceRow('inaccessible-model', {
      owner_user_id: 99,
      created_by: 99,
      modelSettings: { version: 2 }
    });
    const db = database([[[managedRow, inaccessibleRow], []]]);
    const access = managementAccess();
    access.canManageModel.mockImplementation(
      async (_userId, modelId) => modelId === 'managed-model'
    );
    const service = new MarAgentModelService(db, Date.now, undefined, access);

    await expect(service.listManagedForUser(8)).resolves.toEqual([
      expect.objectContaining({ id: 'managed-model' })
    ]);
    expect(access.canManageModel).toHaveBeenCalledWith(8, 'inaccessible-model');
    const settingsJoin = db.raw.execute.mock.calls.find(([sql]) =>
      String(sql).includes('LEFT JOIN system_settings model_settings')
    );
    expect(settingsJoin?.[1]).toEqual(['managed-model']);
  });

  it('does not join settings when the user has no authorized model IDs', async () => {
    const inaccessibleRow = modelServiceRow('inaccessible-model', {
      owner_user_id: 99,
      created_by: 99,
      modelSettings: { version: 2 }
    });
    const listDb = database([[[inaccessibleRow], []]]);
    const listAccess = managementAccess();
    listAccess.canUseModel.mockResolvedValue(false);
    await expect(
      new MarAgentModelService(listDb, Date.now, undefined, listAccess).listForUser(8)
    ).resolves.toEqual([]);
    expect(
      listDb.raw.execute.mock.calls.some(([sql]) =>
        String(sql).includes('LEFT JOIN system_settings model_settings')
      )
    ).toBe(false);

    const managedDb = database([[[inaccessibleRow], []]]);
    const managedAccess = managementAccess();
    managedAccess.canManageModel.mockResolvedValue(false);
    await expect(
      new MarAgentModelService(managedDb, Date.now, undefined, managedAccess).listManagedForUser(8)
    ).resolves.toEqual([]);
    expect(
      managedDb.raw.execute.mock.calls.some(([sql]) =>
        String(sql).includes('LEFT JOIN system_settings model_settings')
      )
    ).toBe(false);

    const storedDb = database([[[inaccessibleRow], []]]);
    const storedAccess = managementAccess();
    storedAccess.canUseModel.mockResolvedValue(false);
    await expect(
      new MarAgentModelService(
        storedDb,
        Date.now,
        undefined,
        storedAccess
      ).storedConfigurationsForUser(8)
    ).resolves.toEqual([]);
    expect(
      storedDb.raw.execute.mock.calls.some(([sql]) =>
        String(sql).includes('LEFT JOIN system_settings model_settings')
      )
    ).toBe(false);
  });

  it('creates by model ID when an inaccessible model has an invalid settings document', async () => {
    const modelId = 'created-model';
    const createdRow = modelServiceRow(modelId, {
      name: input.name,
      model_id: input.modelId,
      credential: JSON.stringify({ type: 'INLINE_API_KEY', value: 'secret' })
    });
    const inaccessibleRow = modelServiceRow('inaccessible-model', {
      owner_user_id: 99,
      created_by: 99,
      modelSettings: { version: 2 }
    });
    const db = database([
      [{ affectedRows: 1 }, []],
      [[createdRow, inaccessibleRow], []]
    ]);
    const service = new MarAgentModelService(db, Date.now, () => modelId, managementAccess());

    await expect(service.create(7, input)).resolves.toMatchObject({
      id: modelId,
      name: input.name
    });
    expect(db.connection.commit).toHaveBeenCalledOnce();
    const settingsJoins = db.raw.execute.mock.calls.filter(([sql]) =>
      String(sql).includes('LEFT JOIN system_settings model_settings')
    );
    expect(settingsJoins.map(([, parameters]) => parameters)).toEqual([[modelId]]);
  });

  it('updates by model ID when another model has an invalid settings document', async () => {
    const modelId = 'managed-model';
    const managedRow = modelServiceRow(modelId);
    const inaccessibleRow = modelServiceRow('inaccessible-model', {
      owner_user_id: 99,
      created_by: 99,
      modelSettings: { version: 2 }
    });
    const db = database([
      [[managedRow, inaccessibleRow], []],
      [[managedRow, inaccessibleRow], []],
      [[{ sort_order: 0 }], []],
      [{ affectedRows: 1 }, []],
      [[{ ...managedRow, name: 'Updated model' }, inaccessibleRow], []]
    ]);
    const service = new MarAgentModelService(db, Date.now, undefined, managementAccess());

    await expect(service.update(7, modelId, { name: 'Updated model' })).resolves.toMatchObject({
      id: modelId,
      name: 'Updated model'
    });
    const settingsJoins = db.raw.execute.mock.calls.filter(([sql]) =>
      String(sql).includes('LEFT JOIN system_settings model_settings')
    );
    expect(settingsJoins.map(([, parameters]) => parameters)).toEqual([
      [modelId],
      [modelId],
      [modelId]
    ]);
  });

  it('fails closed when the updated model settings document is invalid', async () => {
    const db = database([
      [[modelServiceRow('broken-model', { modelSettings: { version: 2 } })], []]
    ]);
    const service = new MarAgentModelService(db, Date.now, undefined, managementAccess());

    await expect(service.update(7, 'broken-model', { name: 'Should not persist' })).rejects.toThrow(
      'MAR_AGENT_MODEL_CONFIG_INVALID'
    );
    expect(db.connection.beginTransaction).not.toHaveBeenCalled();
    expect(
      db.raw.execute.mock.calls.some(([sql]) => String(sql).startsWith('UPDATE mar_agent_models'))
    ).toBe(false);
  });

  it('filters summaries and runtime configurations through model resource access', async () => {
    const rows = [
      {
        id: 'coding-id',
        name: 'Coding',
        protocol: 'ANTHROPIC_MESSAGES',
        base_url: 'https://gateway.example.test',
        api_key: 'coding-secret',
        model_id: 'coding',
        context_window_tokens: 200000,
        max_output_tokens: 16384,
        input_capabilities: '["TEXT"]',
        output_capabilities: '["TEXT"]',
        reasoning_efforts: '[]',
        enabled: 1,
        sort_order: 0,
        last_tested_at: null,
        last_test_status: 'UNVERIFIED',
        last_test_code: null,
        public_access: 1
      },
      {
        id: 'review-id',
        name: 'Review',
        protocol: 'OPENAI_RESPONSES',
        base_url: 'https://review.example.test',
        api_key: 'review-secret',
        model_id: 'review',
        context_window_tokens: 128000,
        max_output_tokens: 8192,
        input_capabilities: '["TEXT"]',
        output_capabilities: '["TEXT"]',
        reasoning_efforts: '[]',
        enabled: 1,
        sort_order: 1,
        last_tested_at: null,
        last_test_status: 'UNVERIFIED',
        last_test_code: null,
        public_access: 0
      },
      {
        id: 'disabled-id',
        name: 'Disabled',
        protocol: 'OPENAI_RESPONSES',
        base_url: 'https://disabled.example.test',
        api_key: 'disabled-secret',
        model_id: 'disabled',
        context_window_tokens: 128000,
        max_output_tokens: 8192,
        input_capabilities: '["TEXT"]',
        output_capabilities: '["TEXT"]',
        reasoning_efforts: '[]',
        enabled: 0,
        sort_order: 2,
        last_tested_at: null,
        last_test_status: 'UNVERIFIED',
        last_test_code: null,
        public_access: 1
      }
    ];
    const access = {
      ...managementAccess(),
      canUseModel: vi.fn(async (_userId: number, modelId: string) => modelId === 'coding-id')
    };
    const db = database([
      [rows, []],
      [[], []],
      [rows.filter((row) => row.enabled === 1), []]
    ]);
    const service = new MarAgentModelService(db, Date.now, undefined, access);

    await expect(service.listForUser(8)).resolves.toEqual([
      expect.objectContaining({ id: 'coding-id', access: 'PUBLIC' })
    ]);
    await expect(service.runtimeConfigurationsForUser(8)).resolves.toEqual([
      expect.objectContaining({ id: 'coding-id', apiKey: 'coding-secret' })
    ]);
    expect(access.canUseModel).toHaveBeenCalledWith(8, 'review-id');
    expect(access.canUseModel).not.toHaveBeenCalledWith(8, 'disabled-id');
    const settingsJoins = db.raw.execute.mock.calls.filter(([sql]) =>
      String(sql).includes('LEFT JOIN system_settings model_settings')
    );
    expect(settingsJoins.map(([, parameters]) => parameters)).toEqual([
      ['coding-id'],
      ['coding-id']
    ]);
  });

  it('rechecks enabled and conversation facts after authorization before loading settings', async () => {
    const rows = [
      modelServiceRow('visible', { enabled: 1, conversation_model: 1 }),
      modelServiceRow('changed', { enabled: 1, conversation_model: 1 }),
      modelServiceRow('non-conversation', { enabled: 1, conversation_model: 0 })
    ];
    const finalRows = rows.map((row) =>
      row.id === 'changed' ? { ...row, conversation_model: 0 } : row
    );
    const access = managementAccess();
    const db = database([
      [rows, []],
      [finalRows, []],
      [[], []]
    ]);
    const service = new MarAgentModelService(db, Date.now, undefined, access);

    await expect(service.listForUser(7)).resolves.toEqual([
      expect.objectContaining({ id: 'visible' })
    ]);
    expect(access.canUseModel).not.toHaveBeenCalledWith(7, 'non-conversation');
    const [join] = db.raw.execute.mock.calls.find(([sql]) =>
      String(sql).includes('LEFT JOIN system_settings model_settings')
    )!;
    expect(join).toContain('model.enabled=1');
    expect(join).toContain('model.conversation_model=1');
  });

  it('applies a user model order only to that user’s visible model directory', async () => {
    const rows = [
      {
        id: 'coding-id',
        name: 'Coding',
        protocol: 'ANTHROPIC_MESSAGES',
        base_url: 'https://gateway.example.test',
        model_id: 'coding',
        context_window_tokens: 200000,
        max_output_tokens: 16384,
        input_capabilities: '["TEXT"]',
        output_capabilities: '["TEXT"]',
        reasoning_efforts: '[]',
        enabled: 1,
        sort_order: 0,
        last_tested_at: null,
        last_test_status: 'UNVERIFIED',
        last_test_code: null,
        public_access: 1
      },
      {
        id: 'review-id',
        name: 'Review',
        protocol: 'OPENAI_RESPONSES',
        base_url: 'https://review.example.test',
        model_id: 'review',
        context_window_tokens: 128000,
        max_output_tokens: 8192,
        input_capabilities: '["TEXT"]',
        output_capabilities: '["TEXT"]',
        reasoning_efforts: '[]',
        enabled: 1,
        sort_order: 1,
        last_tested_at: null,
        last_test_status: 'UNVERIFIED',
        last_test_code: null,
        public_access: 1
      }
    ];
    const service = new MarAgentModelService(
      database([
        [rows, []],
        [[{ model_id: 'review-id', sort_order: 0 }], []],
        [rows, []],
        [[], []]
      ]),
      Date.now,
      undefined,
      { ...managementAccess(), canUseModel: vi.fn(async () => true) }
    );

    await expect(service.listForUser(8)).resolves.toEqual([
      expect.objectContaining({ id: 'review-id' }),
      expect.objectContaining({ id: 'coding-id' })
    ]);
    await expect(service.listForUser(9)).resolves.toEqual([
      expect.objectContaining({ id: 'coding-id' }),
      expect.objectContaining({ id: 'review-id' })
    ]);
  });

  it('keeps the first personally ordered model for each normalized model name', async () => {
    const rows = [
      {
        id: 'enterprise-terra',
        name: 'GPT-5.6-Terra',
        protocol: 'OPENAI_RESPONSES',
        base_url: 'https://enterprise.example.test',
        model_id: 'enterprise-terra',
        context_window_tokens: 200000,
        max_output_tokens: 16384,
        input_capabilities: '["TEXT"]',
        output_capabilities: '["TEXT"]',
        reasoning_efforts: '["high"]',
        default_reasoning_effort: 'high',
        enabled: 1,
        sort_order: 0,
        last_tested_at: null,
        last_test_status: 'UNVERIFIED',
        last_test_code: null,
        public_access: 1
      },
      {
        id: 'personal-terra',
        name: 'ｇｐｔ-5.6-terra',
        protocol: 'OPENAI_RESPONSES',
        base_url: 'https://personal.example.test',
        model_id: 'personal-terra',
        context_window_tokens: 200000,
        max_output_tokens: 16384,
        input_capabilities: '["TEXT"]',
        output_capabilities: '["TEXT"]',
        reasoning_efforts: '["high"]',
        default_reasoning_effort: 'high',
        enabled: 1,
        sort_order: 1,
        last_tested_at: null,
        last_test_status: 'UNVERIFIED',
        last_test_code: null,
        public_access: 0
      },
      {
        id: 'review',
        name: 'Review',
        protocol: 'OPENAI_RESPONSES',
        base_url: 'https://review.example.test',
        model_id: 'review',
        context_window_tokens: 128000,
        max_output_tokens: 8192,
        input_capabilities: '["TEXT"]',
        output_capabilities: '["TEXT"]',
        reasoning_efforts: '[]',
        default_reasoning_effort: 'medium',
        enabled: 1,
        sort_order: 2,
        last_tested_at: null,
        last_test_status: 'UNVERIFIED',
        last_test_code: null,
        public_access: 1
      }
    ];
    const service = new MarAgentModelService(
      database([
        [rows, []],
        [[{ model_id: 'personal-terra', sort_order: 0 }], []]
      ]),
      Date.now,
      undefined,
      { ...managementAccess(), canUseModel: vi.fn(async () => true) }
    );

    await expect(service.listForUser(8)).resolves.toEqual([
      expect.objectContaining({ id: 'personal-terra' }),
      expect.objectContaining({ id: 'review' })
    ]);
  });

  it('rewrites only the current user’s visible model order', async () => {
    const connection = {
      beginTransaction: vi.fn(async () => undefined),
      execute: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        if (sql.includes('SELECT id FROM users')) return [[{ id: values[0] }], []];
        if (sql.includes('SELECT id FROM mar_agent_models WHERE id=? FOR SHARE'))
          return [[{ id: values[0] }], []];
        return [{ affectedRows: 1 }, []];
      }),
      commit: vi.fn(async () => undefined),
      rollback: vi.fn(async () => undefined),
      release: vi.fn()
    };
    const service = new MarAgentModelService(
      {
        raw: {
          getConnection: vi.fn(async () => connection)
        }
      } as unknown as MysqlServerDatabase,
      () => 123
    );
    vi.spyOn(service, 'listForUser').mockResolvedValue([
      { id: 'model-1' } as unknown as Awaited<ReturnType<typeof service.listForUser>>[number]
    ]);

    await service.reorderForUser(8, { modelIds: ['model-1'] });

    expect(connection.execute).toHaveBeenNthCalledWith(
      3,
      'DELETE FROM user_mar_agent_model_orders WHERE user_id=?',
      [8]
    );
    expect(connection.execute).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining('INSERT INTO user_mar_agent_model_orders'),
      [8, 'model-1', 0, 123]
    );
    expect(connection.commit).toHaveBeenCalledOnce();
  });

  it('lists enabled template model options and keeps the first normalized model name', async () => {
    const db = database([
      [
        [
          { model_id: 'coding-primary', name: 'Coding', normalized_name: 'coding' },
          { model_id: 'coding-secondary', name: 'ＣＯＤＩＮＧ', normalized_name: 'coding' },
          { model_id: 'review', name: 'Review', normalized_name: 'review' }
        ],
        []
      ],
      [[{ model_id: 'coding', name: 'Coding Personal' }], []]
    ]);
    const access = {
      ...managementAccess(),
      canUseModel: vi.fn(async () => false),
      nodeOwnership: vi.fn(async (nodeId: string) =>
        nodeId === 'organization-node'
          ? { ownerType: 'ORGANIZATION' as const, ownerOrganizationId: 4 }
          : nodeId === 'personal-node'
            ? { ownerType: 'PERSONAL' as const, ownerUserId: 8 }
            : undefined
      )
    };
    const service = new MarAgentModelService(db, Date.now, undefined, access);

    await expect(service.listTemplateOptionsForNode('organization-node')).resolves.toEqual([
      { modelId: 'coding-primary', name: 'Coding' },
      { modelId: 'review', name: 'Review' }
    ]);
    await expect(service.listTemplateOptionsForNode('personal-node')).resolves.toEqual([
      { modelId: 'coding', name: 'Coding Personal' }
    ]);
    await expect(service.listTemplateOptionsForNode('missing-node')).rejects.toThrow(
      'NODE_NOT_FOUND'
    );

    const [organizationSql, organizationParams] = db.raw.execute.mock.calls[0]!;
    expect(String(organizationSql)).toContain('WITH RECURSIVE node_model_organizations');
    expect(String(organizationSql)).toContain("grant_record.target_type='ORGANIZATION'");
    expect(String(organizationSql)).toContain('grant_record.target_organization_id=1');
    expect(String(organizationSql)).toContain("grant_record.target_type='USER'");
    expect(String(organizationSql)).toContain('model.enabled=1');
    expect(String(organizationSql)).toContain('ORDER BY model.sort_order,model.normalized_name');
    expect(organizationParams).toEqual([4, null, null]);
    expect(db.raw.execute.mock.calls[1]![1]).toEqual([null, 8, 8]);
  });

  it('rejects a directly submitted model ID when the user lacks its resource grant', async () => {
    const access = { ...managementAccess(), canUseModel: vi.fn(async () => false) };
    const db = database();
    const service = new MarAgentModelService(db, Date.now, undefined, access);

    await expect(service.runtimeForUser(8, 'restricted-id')).rejects.toThrow(
      'MAR_AGENT_MODEL_FORBIDDEN'
    );
    expect(db.raw.execute).not.toHaveBeenCalled();
  });

  it('deletes an enabled model even while an existing execution holds a lease', async () => {
    const db = database([
      [
        [
          {
            id: 'coding-id',
            name: 'Coding',
            protocol: 'ANTHROPIC_MESSAGES',
            base_url: 'https://gateway.example.test',
            api_key: 'secret',
            model_id: 'coding',
            context_window_tokens: 200000,
            max_output_tokens: 16384,
            input_capabilities: '["TEXT"]',
            output_capabilities: '["TEXT"]',
            reasoning_efforts: '[]',
            enabled: 1,
            last_tested_at: null,
            last_test_status: 'UNVERIFIED',
            last_test_code: null
          }
        ],
        []
      ],
      [{ affectedRows: 1 }, []]
    ]);
    const service = new MarAgentModelService(db);
    const lease = await service.lease('coding-id');

    await expect(service.remove('coding-id')).resolves.toBeUndefined();

    expect(db.raw.execute).toHaveBeenCalledWith('DELETE FROM mar_agent_models WHERE id=?', [
      'coding-id'
    ]);
    lease.release();
  });

  it('atomically saves a complete unique model order', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([[{ id: 'a' }, { id: 'b' }], []])
      .mockResolvedValue([{ affectedRows: 1 }, []]);
    const connection = {
      beginTransaction: vi.fn(),
      execute,
      commit: vi.fn(),
      rollback: vi.fn(),
      release: vi.fn()
    };
    const service = new MarAgentModelService({
      raw: { getConnection: vi.fn().mockResolvedValue(connection) }
    } as never);

    await service.reorder({ modelIds: ['b', 'a'] });

    expect(execute).toHaveBeenNthCalledWith(
      2,
      'UPDATE mar_agent_models SET sort_order=? WHERE id=?',
      [0, 'b']
    );
    expect(execute).toHaveBeenNthCalledWith(
      3,
      'UPDATE mar_agent_models SET sort_order=? WHERE id=?',
      [1, 'a']
    );
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledOnce();
  });

  it('rolls back when the submitted model order is incomplete', async () => {
    const execute = vi.fn().mockResolvedValueOnce([[{ id: 'a' }, { id: 'b' }], []]);
    const connection = {
      beginTransaction: vi.fn(),
      execute,
      commit: vi.fn(),
      rollback: vi.fn(),
      release: vi.fn()
    };
    const service = new MarAgentModelService({
      raw: { getConnection: vi.fn().mockResolvedValue(connection) }
    } as never);

    await expect(service.reorder({ modelIds: ['a'] })).rejects.toThrow(
      'MAR_AGENT_MODEL_CONFIG_INVALID'
    );

    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(connection.release).toHaveBeenCalledOnce();
  });

  it('reorders only the complete manageable model set and leaves other users models untouched', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([[{ id: 'a' }, { id: 'other-users-model' }, { id: 'b' }], []])
      .mockResolvedValue([{ affectedRows: 1 }, []]);
    const connection = {
      beginTransaction: vi.fn(),
      execute,
      commit: vi.fn(),
      rollback: vi.fn(),
      release: vi.fn()
    };
    const service = new MarAgentModelService({
      raw: { getConnection: vi.fn().mockResolvedValue(connection) }
    } as never);
    vi.spyOn(service, 'listManagedForUser').mockResolvedValue([{ id: 'a' }, { id: 'b' }] as never);

    await service.reorder({ modelIds: ['b', 'a'] }, 7);

    expect(execute.mock.calls.slice(1).map(([, params]) => params)).toEqual([
      [0, 'b'],
      [1, 'a']
    ]);
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.rollback).not.toHaveBeenCalled();
  });

  it.each([
    { requested: ['a'], managed: ['a', 'b'], locked: ['a', 'b', 'hidden'] },
    { requested: ['a', 'hidden'], managed: ['a', 'b'], locked: ['a', 'b', 'hidden'] },
    { requested: ['a', 'b'], managed: ['a'], locked: ['a', 'b', 'hidden'] },
    { requested: ['a', 'b'], managed: ['a', 'b'], locked: ['a', 'hidden'] },
    { requested: ['a', 'a'], managed: ['a', 'b'], locked: ['a', 'b', 'hidden'] }
  ])(
    'rejects invalid manageable order without changing any model: $requested / $managed / $locked',
    async ({ requested, managed, locked }) => {
      const execute = vi.fn().mockResolvedValueOnce([locked.map((id) => ({ id })), []]);
      const connection = {
        beginTransaction: vi.fn(),
        execute,
        commit: vi.fn(),
        rollback: vi.fn(),
        release: vi.fn()
      };
      const getConnection = vi.fn().mockResolvedValue(connection);
      const service = new MarAgentModelService({ raw: { getConnection } } as never);
      vi.spyOn(service, 'listManagedForUser').mockResolvedValue(
        managed.map((id) => ({ id })) as never
      );
      await expect(service.reorder({ modelIds: requested }, 7)).rejects.toThrow(
        'MAR_AGENT_MODEL_CONFIG_INVALID'
      );
      expect(execute.mock.calls.length).toBeLessThanOrEqual(1);
      expect(connection.commit).not.toHaveBeenCalled();
      if (getConnection.mock.calls.length) {
        expect(connection.rollback).toHaveBeenCalledOnce();
        expect(connection.release).toHaveBeenCalledOnce();
      }
    }
  );

  it.each([
    {
      limits: 'catalog',
      contextWindowTokens: 200_000,
      requestedContext: 96_000,
      expectedContext: 200_000
    },
    {
      limits: 'default',
      contextWindowTokens: undefined,
      requestedContext: undefined,
      expectedContext: 256_000
    },
    {
      limits: 'manual',
      contextWindowTokens: undefined,
      requestedContext: 96_000,
      expectedContext: 96_000
    }
  ])(
    'imports a Codex catalog atomically with $limits limits, new IDs and per-model outcomes',
    async ({ contextWindowTokens, requestedContext, expectedContext }) => {
      const credentialId = 'credential-1';
      const execute = vi.fn(async (sql: unknown, parameters?: readonly unknown[]) => {
        void parameters;
        if (String(sql).includes('SELECT sort_order FROM mar_agent_models FOR UPDATE'))
          return [[{ sort_order: 3 }], []];
        return [{ affectedRows: 1 }, []];
      });
      const connectionExecute = vi.fn(async (sql: unknown, parameters?: readonly unknown[]) => {
        if (String(sql).includes('SELECT id FROM users')) return [[{ id: parameters?.[0] }], []];
        if (String(sql).includes('SELECT id FROM mar_agent_models WHERE id=? FOR SHARE'))
          return [[{ id: parameters?.[0] }], []];
        return execute(sql, parameters);
      });
      const connection = {
        beginTransaction: vi.fn(),
        execute: connectionExecute,
        commit: vi.fn(),
        rollback: vi.fn(),
        release: vi.fn()
      };
      const service = new MarAgentModelService(
        {
          raw: { getConnection: vi.fn().mockResolvedValue(connection) }
        } as never,
        () => 10,
        undefined,
        managementAccess(),
        { assertModelCredentialBinding: vi.fn() }
      );
      const catalog: CodexModelCatalog = {
        catalogHash: 'c'.repeat(64),
        fetchedAt: 9,
        models: [
          {
            upstreamModelId: 'gpt-codex',
            displayName: 'GPT Codex',
            ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
            reasoningEfforts: ['low', 'high'],
            defaultReasoningEffort: 'high',
            unsupportedReasoningEfforts: [],
            inputCapabilities: ['TEXT', 'IMAGE'],
            hostedWebSearch: true,
            warnings: [],
            requiredInputs: contextWindowTokens === undefined ? ['contextWindowTokens'] : []
          },
          {
            upstreamModelId: 'gpt-codex-mini',
            displayName: 'GPT Codex Mini',
            contextWindowTokens: 120_000,
            maxOutputTokens: 16_000,
            reasoningEfforts: ['medium'],
            defaultReasoningEffort: 'medium',
            unsupportedReasoningEfforts: [],
            inputCapabilities: ['TEXT'],
            hostedWebSearch: false,
            warnings: [],
            requiredInputs: []
          },
          {
            upstreamModelId: 'unsupported-reasoning',
            displayName: 'Unsupported',
            contextWindowTokens: 120_000,
            maxOutputTokens: 16_000,
            reasoningEfforts: [],
            defaultReasoningEffort: 'medium',
            unsupportedReasoningEfforts: ['extreme'],
            inputCapabilities: ['TEXT'],
            hostedWebSearch: false,
            warnings: ['Unsupported reasoning effort: extreme'],
            requiredInputs: []
          },
          {
            upstreamModelId: 'small-context',
            displayName: 'Small Context',
            contextWindowTokens: 8_000,
            reasoningEfforts: ['low'],
            defaultReasoningEffort: 'low',
            unsupportedReasoningEfforts: [],
            inputCapabilities: ['TEXT'],
            hostedWebSearch: false,
            warnings: [],
            requiredInputs: []
          }
        ]
      };

      const result = await service.importCodexModels(
        7,
        credentialId,
        codexModelCatalogSchema.parse(catalog),
        {
          catalogHash: catalog.catalogHash,
          models: [
            {
              upstreamModelId: 'gpt-codex',
              ...(requestedContext === undefined ? {} : { contextWindowTokens: requestedContext }),
              enabled: true
            },
            {
              upstreamModelId: 'gpt-codex-mini',
              name: 'Codex Mini',
              enabled: false
            },
            {
              upstreamModelId: 'unsupported-reasoning',
              enabled: true
            },
            {
              upstreamModelId: 'small-context',
              enabled: true
            }
          ]
        }
      );

      expect(result.items).toEqual([
        expect.objectContaining({
          upstreamModelId: 'gpt-codex',
          status: 'CREATED',
          modelId: expect.stringMatching(/^model-[A-Za-z0-9_-]{16}$/u)
        }),
        expect.objectContaining({
          upstreamModelId: 'gpt-codex-mini',
          status: 'CREATED',
          modelId: expect.stringMatching(/^model-/u)
        }),
        expect.objectContaining({
          upstreamModelId: 'unsupported-reasoning',
          status: 'CREATED',
          modelId: expect.stringMatching(/^model-/u)
        }),
        expect.objectContaining({
          upstreamModelId: 'small-context',
          status: 'CREATED',
          modelId: expect.stringMatching(/^model-/u)
        })
      ]);
      const inserts = execute.mock.calls.filter(([sql]) =>
        String(sql).startsWith('INSERT INTO mar_agent_models')
      );
      expect(inserts).toHaveLength(4);
      const modelInsert = (upstreamModelId: string) =>
        inserts.find(([, parameters]) => parameters?.[5] === upstreamModelId)!;
      const firstInsert = modelInsert('gpt-codex');
      const firstParams = firstInsert[1]!;
      expect(firstParams).toContain(
        JSON.stringify({ type: 'CREDENTIAL_REF', credentialId: 'credential-1' })
      );
      expect(String(firstInsert[0])).toContain('default_reasoning_effort');
      expect(String(firstInsert[0])).not.toContain('responses_encoding');
      expect(
        execute.mock.calls.filter(([sql]) => String(sql).startsWith('UPDATE mar_agent_models'))
      ).toHaveLength(0);
      expect(firstParams[10]).toBe(JSON.stringify(['low', 'high']));
      expect(firstParams[11]).toBe('high');
      expect(firstParams[6]).toBe(expectedContext);
      expect(firstParams[7]).toBe(32_000);
      expect(firstParams[12]).toBe(false);
      expect(firstParams[13]).toBe(true);
      expect(modelSettingsDocument(execute, String(firstParams[0]))).toEqual({
        version: 1,
        hostedWebSearch: true,
        serviceTier: 'default',
        responsesTransport: { transport: 'WEBSOCKET' },
        responsesPreviousResponseId: true
      });

      const miniParams = modelInsert('gpt-codex-mini')[1]!;
      expect(miniParams[6]).toBe(120_000);
      expect(miniParams[7]).toBe(16_000);
      expect(miniParams[12]).toBe(false);
      expect(miniParams[13]).toBe(false);
      expect(modelSettingsDocument(execute, String(miniParams[0]))).toEqual({
        version: 1,
        hostedWebSearch: false,
        serviceTier: 'default',
        responsesTransport: { transport: 'WEBSOCKET' },
        responsesPreviousResponseId: true
      });

      const unsupportedParams = modelInsert('unsupported-reasoning')[1]!;
      expect(unsupportedParams[10]).toBe(JSON.stringify([]));
      expect(unsupportedParams[11]).toBe('medium');
      expect(modelInsert('small-context')[1]?.[7]).toBe(7_999);
      expect(connection.commit).toHaveBeenCalledOnce();
      expect(connection.rollback).not.toHaveBeenCalled();
      expect(connection.release).toHaveBeenCalledOnce();
    }
  );

  it('imports the same upstream model and display name independently for another credential', async () => {
    const existingCredentialId = 'credential-1';
    const importedCredentialId = 'credential-2';
    const upstreamModelId = 'gpt-codex';
    const existing = {
      id: importedCodexModelId(existingCredentialId, upstreamModelId),
      name: 'Shared Name',
      normalized_name: 'shared name',
      protocol: 'OPENAI_RESPONSES',
      base_url: 'https://chatgpt.com/backend-api/codex',
      credential: JSON.stringify({
        type: 'CREDENTIAL_REF',
        credentialId: existingCredentialId
      }),
      model_id: upstreamModelId,
      context_window_tokens: 200_000,
      max_output_tokens: 16_000,
      input_capabilities: JSON.stringify(['TEXT']),
      output_capabilities: JSON.stringify(['TEXT']),
      reasoning_efforts: JSON.stringify(['high']),
      default_reasoning_effort: 'high',
      enabled: 1,
      sort_order: 0
    };
    const execute = vi.fn(async (sql: unknown, parameters?: readonly unknown[]) => {
      if (String(sql).includes('SELECT id FROM users'))
        return [[{ id: parameters?.[0] }], []] as never;
      void parameters;
      if (String(sql).includes('SELECT sort_order FROM mar_agent_models'))
        return [[existing], []] as never;
      if (String(sql).includes('SELECT COALESCE(MAX(sort_order)'))
        return [[{ next_sort_order: 1 }], []] as never;
      return [{ affectedRows: 2 }, []] as never;
    });
    const connection = {
      beginTransaction: vi.fn(),
      execute,
      commit: vi.fn(),
      rollback: vi.fn(),
      release: vi.fn()
    };
    const service = new MarAgentModelService(
      {
        raw: { getConnection: vi.fn().mockResolvedValue(connection) }
      } as never,
      Date.now,
      undefined,
      undefined,
      { assertModelCredentialBinding: vi.fn() }
    );
    const catalog: CodexModelCatalog = {
      catalogHash: 'd'.repeat(64),
      fetchedAt: 10,
      models: [
        {
          upstreamModelId,
          displayName: 'Shared Name',
          contextWindowTokens: 200_000,
          maxOutputTokens: 16_000,
          reasoningEfforts: ['high'],
          defaultReasoningEffort: 'high',
          unsupportedReasoningEfforts: [],
          inputCapabilities: ['TEXT'],
          hostedWebSearch: true,
          warnings: [],
          requiredInputs: []
        }
      ]
    };

    const expectedModelId = expect.stringMatching(/^model-[A-Za-z0-9_-]{16}$/u);
    await expect(
      service.importCodexModels(7, importedCredentialId, catalog, {
        catalogHash: catalog.catalogHash,
        models: [{ upstreamModelId, enabled: true }]
      })
    ).resolves.toEqual({
      items: [
        {
          upstreamModelId,
          status: 'CREATED',
          modelId: expectedModelId
        }
      ]
    });
    const insert = execute.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO mar_agent_models')
    );
    expect(insert?.[1]?.[0]).toEqual(expectedModelId);
    expect(insert?.[1]?.[0]).not.toBe(existing.id);
    expect(insert?.[1]?.[1]).toBe('Shared Name');
    expect(insert?.[1]?.[4]).toBe(
      JSON.stringify({ type: 'CREDENTIAL_REF', credentialId: importedCredentialId })
    );
    expect(execute.mock.calls.some(([sql]) => String(sql).includes('resource_grants'))).toBe(false);
    expect(connection.commit).toHaveBeenCalledOnce();
  });

  it.each([
    'https://chatgpt.com/backend-api/codex',
    'https://api.openai.com/v1',
    'https://cli-chat-proxy.grok.com/v1'
  ])('creates independent models on repeated catalog imports for %s', async (baseUrl) => {
    const upstreamModelId = 'gpt-codex';
    const credentialId = 'credential-1';
    const existing = {
      id: importedCodexModelId(credentialId, upstreamModelId),
      name: 'GPT Codex',
      normalized_name: 'gpt codex',
      protocol: 'OPENAI_RESPONSES',
      base_url: baseUrl,
      credential: JSON.stringify({ type: 'CREDENTIAL_REF', credentialId }),
      model_id: upstreamModelId,
      context_window_tokens: 200_000,
      max_output_tokens: 16_000,
      input_capabilities: JSON.stringify(['TEXT', 'IMAGE']),
      output_capabilities: JSON.stringify(['TEXT']),
      reasoning_efforts: JSON.stringify(['low', 'high']),
      default_reasoning_effort: 'high',
      code_mode: 1,
      high_density_compaction: 1,
      modelSettings: {
        version: 1,
        hostedWebSearch: true,
        serviceTier: 'priority',
        responsesTransport: { transport: 'WEBSOCKET' },
        responsesPreviousResponseId: true
      },
      enabled: 1,
      sort_order: 3
    };
    const storedOrders = [{ sort_order: existing.sort_order }];
    const execute = vi.fn(async (sql: unknown, parameters?: readonly unknown[]) => {
      if (String(sql).includes('SELECT id FROM users'))
        return [[{ id: parameters?.[0] }], []] as never;
      if (String(sql).includes('SELECT sort_order FROM mar_agent_models'))
        return [storedOrders, []] as never;
      if (String(sql).includes('INSERT INTO mar_agent_models'))
        storedOrders.push({ sort_order: Number(parameters?.[14]) });
      return [{ affectedRows: 1 }, []] as never;
    });
    const connection = {
      beginTransaction: vi.fn(),
      execute,
      commit: vi.fn(),
      rollback: vi.fn(),
      release: vi.fn()
    };
    const service = new CoreMarAgentModelService(
      {
        raw: { getConnection: vi.fn().mockResolvedValue(connection) }
      } as never,
      () => 20,
      undefined,
      managementAccess(),
      {
        assertModelCredentialBinding: vi.fn(),
        credentialTarget: vi.fn().mockResolvedValue(baseUrl)
      }
    );
    const catalog: CodexModelCatalog = {
      catalogHash: 'e'.repeat(64),
      fetchedAt: 10,
      models: [
        {
          upstreamModelId,
          displayName: 'GPT Codex',
          contextWindowTokens: 200_000,
          maxOutputTokens: 16_000,
          reasoningEfforts: ['low', 'high'],
          defaultReasoningEffort: 'high',
          unsupportedReasoningEfforts: [],
          inputCapabilities: ['TEXT', 'IMAGE'],
          hostedWebSearch: true,
          warnings: [],
          requiredInputs: []
        }
      ]
    };

    const request = {
      catalogHash: catalog.catalogHash,
      models: [{ upstreamModelId, enabled: true }]
    };
    const first = await service.importCodexModels(7, credentialId, catalog, request);
    const second = await service.importCodexModels(7, credentialId, catalog, request);
    for (const result of [first, second]) {
      expect(result.items).toEqual([
        {
          upstreamModelId,
          status: 'CREATED',
          modelId: expect.stringMatching(/^model-[A-Za-z0-9_-]{16}$/u)
        }
      ]);
      expect(result.items[0]?.modelId).not.toBe(existing.id);
    }
    expect(first.items[0]?.modelId).not.toBe(second.items[0]?.modelId);
    const inserts = execute.mock.calls.filter(([sql]) =>
      String(sql).includes('INSERT INTO mar_agent_models')
    );
    expect(inserts).toHaveLength(2);
    expect(inserts.map((insert) => insert[1]?.[14])).toEqual([4, 5]);
    for (const insert of inserts) {
      expect(insert[1]?.[3]).toBe(baseUrl);
      expect(insert[1]?.[4]).toBe(JSON.stringify({ type: 'CREDENTIAL_REF', credentialId }));
      expect(insert[1]?.[12]).toBe(false);
      expect(insert[1]?.[13]).toBe(true);
      const expectedTransport =
        baseUrl === 'https://cli-chat-proxy.grok.com/v1'
          ? { transport: 'HTTP', httpVersion: '1.1' }
          : { transport: 'WEBSOCKET' };
      const expectedPreviousResponseId = baseUrl !== 'https://cli-chat-proxy.grok.com/v1';
      expect(modelSettingsDocument(execute, String(insert[1]?.[0]))).toEqual({
        version: 1,
        hostedWebSearch: true,
        serviceTier: 'default',
        responsesTransport: expectedTransport,
        responsesPreviousResponseId: expectedPreviousResponseId
      });
      if (baseUrl === 'https://cli-chat-proxy.grok.com/v1') {
        expect(modelSettingsDocument(execute, String(insert[1]?.[0]))).toMatchObject({
          hostedWebSearch: true,
          responsesTransport: { transport: 'HTTP', httpVersion: '1.1' },
          responsesPreviousResponseId: false
        });
      }
    }
    expect(
      execute.mock.calls.some(([sql]) => String(sql).startsWith('UPDATE mar_agent_models'))
    ).toBe(false);
    expect(
      execute.mock.calls.some(
        ([sql, parameters]) =>
          String(sql).startsWith('INSERT INTO system_settings') &&
          parameters?.[0] === `mar_agent_model_config:${existing.id}`
      )
    ).toBe(false);
    expect(execute.mock.calls.some(([sql]) => String(sql).includes('resource_grants'))).toBe(false);
    expect(connection.commit).toHaveBeenCalledTimes(2);
  });

  it('rejects an import when the live catalog hash changed', async () => {
    const service = new MarAgentModelService({ raw: { getConnection: vi.fn() } } as never);
    await expect(
      service.importCodexModels(
        7,
        'credential-1',
        {
          catalogHash: 'a'.repeat(64),
          fetchedAt: 1,
          models: []
        },
        {
          catalogHash: 'b'.repeat(64),
          models: [
            {
              upstreamModelId: 'gpt-codex',
              enabled: true
            }
          ]
        }
      )
    ).rejects.toThrow('CODEX_CATALOG_CHANGED');
  });

  it('records Node transport test results without making a Server-side model request', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const execute = vi.fn(async () => [{ affectedRows: 1 }, []]);
    const service = new MarAgentModelService({ raw: { execute } } as never, () => 123);

    await service.recordTestResult('coding-id', {
      success: false,
      code: 'invalid_request_error',
      message: 'Store must be set to false',
      httpStatus: 400
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith(
      'UPDATE mar_agent_models SET last_tested_at=?,last_test_status=?,last_test_code=?,updated_at=? WHERE id=?',
      [123, 'FAILED', 'invalid_request_error', 123, 'coding-id']
    );
    fetchMock.mockRestore();
  });

  it('returns all enabled models as runtime configurations for internal management callers', async () => {
    const service = new MarAgentModelService(
      database([
        [
          [
            {
              id: 'coding-id',
              name: 'Coding',
              protocol: 'ANTHROPIC_MESSAGES',
              base_url: 'https://gateway.example.test',
              api_key: 'coding-secret',
              model_id: 'coding',
              context_window_tokens: 200000,
              max_output_tokens: 16384,
              input_capabilities: '["TEXT"]',
              output_capabilities: '["TEXT"]',
              reasoning_efforts: '[]',
              enabled: 1,
              last_tested_at: null,
              last_test_status: 'UNVERIFIED',
              last_test_code: null
            },
            {
              id: 'review-id',
              name: 'Review Mini',
              protocol: 'OPENAI_RESPONSES',
              base_url: 'https://review.example.test',
              api_key: 'review-secret',
              model_id: 'review',
              context_window_tokens: 128000,
              max_output_tokens: 8192,
              input_capabilities: '["TEXT"]',
              output_capabilities: '["TEXT"]',
              reasoning_efforts: '[]',
              enabled: 1,
              last_tested_at: null,
              last_test_status: 'UNVERIFIED',
              last_test_code: null
            }
          ],
          []
        ]
      ])
    );
    const result = await service.runtimeConfigurations();
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ id: 'coding-id', apiKey: 'coding-secret', enabled: true });
    expect(result[1]).toMatchObject({ id: 'review-id', apiKey: 'review-secret', enabled: true });
    expect(JSON.stringify(result)).not.toContain('apiKeyConfigured');
  });
});
