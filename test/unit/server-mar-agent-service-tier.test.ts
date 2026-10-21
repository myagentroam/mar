import { describe, expect, it, vi } from 'vitest';
import { MarAgentModelService } from '../../packages/server-core/src/mar-agent-model-service.js';

function fixture(baseUrl: string, oauth: boolean) {
  const row: Record<string, unknown> = {};
  const execute = vi.fn(async (sql: string, values: unknown[] = []) => {
    expect(sql.match(/\?/gu)?.length ?? 0).toBe(values.length);
    if (sql.includes('SELECT id FROM users')) return [[{ id: values[0] }], []];
    if (sql.startsWith('INSERT INTO mar_agent_models')) {
      const columns = sql.match(/mar_agent_models \(([^)]+)\)/u)![1]!.split(',');
      const entries = sql.match(/VALUES \((.+)\)$/u)![1]!.split(',');
      let index = 0;
      columns.forEach((column, position) => {
        row[column] = entries[position] === '?' ? values[index++] : 'UNVERIFIED';
      });
      return [{ affectedRows: 1 }, []];
    }
    if (sql.startsWith('UPDATE mar_agent_models')) {
      const entries = sql.match(/SET (.+) WHERE/u)![1]!.split(',');
      let index = 0;
      for (const entry of entries)
        if (entry.endsWith('=?')) row[entry.slice(0, -2)] = values[index++];
      return [{ affectedRows: 1 }, []];
    }
    return [[{ ...row, public_access: 0, last_tested_at: null }], []];
  });
  const connection = {
    beginTransaction: vi.fn(async () => undefined),
    execute,
    commit: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    release: vi.fn()
  };
  const service = new MarAgentModelService(
    {
      raw: { execute, getConnection: vi.fn(async () => connection) }
    } as unknown as ConstructorParameters<typeof MarAgentModelService>[0],
    () => 10,
    () => 'model',
    undefined,
    {
      assertModelCredentialBinding: vi.fn(),
      assertCredentialTarget: vi.fn(),
      assertStoredCredentialTarget: vi.fn()
    }
  );
  const input = {
    name: 'Model',
    protocol: 'OPENAI_RESPONSES',
    baseUrl,
    credential: oauth
      ? { type: 'CREDENTIAL_REF', credentialId: 'credential' }
      : { type: 'INLINE_API_KEY', value: 'key' },
    modelId: 'upstream',
    contextWindowTokens: 200_000,
    maxOutputTokens: 32_000,
    inputCapabilities: ['TEXT'],
    outputCapabilities: ['TEXT'],
    reasoningEfforts: ['high'],
    defaultReasoningEffort: 'high',
    hostedWebSearch: false,
    enabled: true
  };
  return { row, service, input, execute };
}

describe('Responses standard service-tier persistence', () => {
  it.each([
    ['inline Responses', 'https://api.openai.com/v1', false],
    ['Codex', 'https://chatgpt.com/backend-api/codex', true],
    ['ChatGPT', 'https://api.openai.com/v1', true]
  ] as const)(
    'persists and projects standard tiers for %s independently of the form options',
    async (_name, url, oauth) => {
      const f = fixture(url, oauth);
      for (const serviceTier of [
        'auto',
        'default',
        'flex',
        'priority',
        'fast',
        'ultrafast'
      ] as const) {
        const created = await f.service.create(7, { ...f.input, serviceTier, fastMode: false });
        expect(created.serviceTier).toBe(serviceTier);
        expect(f.row.service_tier).toBe(serviceTier);
        expect((await f.service.stored('model')).serviceTier).toBe(serviceTier);
        expect((await f.service.update(7, 'model', { name: 'Updated' })).serviceTier).toBe(
          serviceTier
        );
      }
      await expect(
        f.service.update(7, 'model', { serviceTier: 'default', fastMode: true })
      ).resolves.toMatchObject({ serviceTier: 'default' });
      await expect(f.service.update(7, 'model', { fastMode: true })).resolves.toMatchObject({
        serviceTier: 'priority'
      });
      await expect(f.service.update(7, 'model', { fastMode: false })).resolves.toMatchObject({
        serviceTier: 'default'
      });
      await expect(f.service.update(7, 'model', { serviceTier: 'invalid' })).rejects.toThrow(
        'MAR_AGENT_MODEL_CONFIG_INVALID'
      );
      f.row.service_tier = 'invalid';
      await expect(f.service.list()).rejects.toThrow('MAR_AGENT_MODEL_CONFIG_INVALID');
    }
  );
});
