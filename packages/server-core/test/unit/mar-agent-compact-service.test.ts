import { describe, expect, it, vi } from 'vitest';
import { MarAgentCompactService } from '../../src/mar-agent-compact-service.js';

interface ManagedModel {
  readonly id: string;
  readonly enabled: boolean;
  readonly reasoningEfforts: readonly string[];
  readonly defaultReasoningEffort?: string;
}

function fixture(managed: readonly ManagedModel[]) {
  const settings = new Map<string, unknown>();
  const execute = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
    if (sql.startsWith('SELECT setting_value FROM system_settings')) {
      const value = settings.get(String(params[0]));
      return [value === undefined ? [] : [{ setting_value: value }]];
    }
    if (sql.startsWith('INSERT INTO system_settings')) {
      settings.set(String(params[0]), JSON.parse(String(params[1])));
      return [{ affectedRows: 1 }];
    }
    return [[]];
  });
  const listManagedForUser = vi.fn(async () => managed);
  const service = new MarAgentCompactService({ raw: { execute } as never }, {
    listManagedForUser
  } as unknown as ConstructorParameters<typeof MarAgentCompactService>[1]);
  return { service, execute, listManagedForUser, settings };
}

const managed: readonly ManagedModel[] = [
  {
    id: 'coding-compact',
    enabled: true,
    reasoningEfforts: ['medium', 'high'],
    defaultReasoningEffort: 'medium'
  },
  {
    id: 'disabled-compact',
    enabled: false,
    reasoningEfforts: ['medium'],
    defaultReasoningEffort: 'medium'
  },
  {
    id: 'fixed-effort',
    enabled: true,
    reasoningEfforts: [],
    defaultReasoningEffort: 'high'
  }
];

describe('MAR Agent compact configuration service', () => {
  it('returns deployment defaults when no setting is stored', async () => {
    const { service } = fixture(managed);
    await expect(service.read()).resolves.toEqual({
      enabled: false,
      modelId: null,
      reasoningEffort: null
    });
  });

  it.each(['object', 'text', 'buffer'] as const)(
    'parses a stored strict configuration from %s',
    async (shape) => {
      const { service, settings } = fixture(managed);
      const configuration = { enabled: true, modelId: 'coding-compact', reasoningEffort: 'high' };
      settings.set(
        'mar_agent_compact',
        shape === 'object'
          ? configuration
          : shape === 'buffer'
            ? Buffer.from(JSON.stringify(configuration))
            : JSON.stringify(configuration)
      );
      await expect(service.read()).resolves.toEqual(configuration);
    }
  );

  it.each([
    ['malformed JSON', 'not-json'],
    [
      'schema-violating value',
      JSON.stringify({ enabled: true, modelId: null, reasoningEffort: 'high' })
    ],
    [
      'extra fields',
      JSON.stringify({ enabled: false, modelId: null, reasoningEffort: null, extra: 1 })
    ],
    ['decoded invalid configuration', { enabled: true, modelId: null, reasoningEffort: 'high' }],
    ['decoded extra fields', { enabled: false, modelId: null, reasoningEffort: null, extra: 1 }],
    ['null', null],
    ['array', []],
    ['number', 42],
    ['malformed JSON buffer', Buffer.from('not-json')]
  ])('rejects a stored %s with one stable code', async (_name, stored) => {
    const { service, settings } = fixture(managed);
    settings.set('mar_agent_compact', stored);
    await expect(service.read()).rejects.toThrow('MAR_AGENT_COMPACT_CONFIG_INVALID');
  });

  it.each([
    [
      'unknown model',
      'MAR_AGENT_COMPACT_MODEL_UNAVAILABLE',
      { enabled: true, modelId: 'removed', reasoningEffort: 'high' }
    ],
    [
      'disabled model',
      'MAR_AGENT_COMPACT_MODEL_UNAVAILABLE',
      { enabled: true, modelId: 'disabled-compact', reasoningEffort: 'medium' }
    ],
    [
      'unsupported effort',
      'MAR_AGENT_COMPACT_EFFORT_INVALID',
      { enabled: true, modelId: 'coding-compact', reasoningEffort: 'low' }
    ],
    [
      'fixed-effort mismatch',
      'MAR_AGENT_COMPACT_EFFORT_INVALID',
      { enabled: true, modelId: 'fixed-effort', reasoningEffort: 'medium' }
    ]
  ])(
    'rejects an enabled write for a %s without touching system_settings',
    async (_name, code, configuration) => {
      const { service, execute, settings } = fixture(managed);
      await expect(service.write(7, configuration)).rejects.toThrow(code);
      expect(execute.mock.calls.filter(([sql]) => sql.startsWith('INSERT'))).toHaveLength(0);
      expect(settings.size).toBe(0);
    }
  );

  it('persists an enabled write for a managed enabled model and effort', async () => {
    const { service, execute, listManagedForUser, settings } = fixture(managed);
    const configuration = { enabled: true, modelId: 'coding-compact', reasoningEffort: 'high' };
    await expect(service.write(7, configuration)).resolves.toEqual(configuration);
    expect(listManagedForUser).toHaveBeenCalledWith(7);
    expect(settings.get('mar_agent_compact')).toEqual(configuration);
    expect(execute.mock.calls.at(-1)![0]).toContain('ON DUPLICATE KEY UPDATE');
    await expect(service.read()).resolves.toEqual(configuration);
  });

  it('keeps a disabled write without validating retained model identity', async () => {
    const { service, listManagedForUser, settings } = fixture([]);
    const configuration = { enabled: false, modelId: 'deleted-model', reasoningEffort: 'high' };
    await expect(service.write(7, configuration)).resolves.toEqual(configuration);
    expect(listManagedForUser).not.toHaveBeenCalled();
    expect(settings.get('mar_agent_compact')).toEqual(configuration);
    await expect(service.read()).resolves.toEqual(configuration);
  });

  it.each([
    ['unknown schema', { enabled: 'yes', modelId: null, reasoningEffort: null }],
    ['enabled without model', { enabled: true, modelId: null, reasoningEffort: 'high' }],
    ['enabled without effort', { enabled: true, modelId: 'coding-compact', reasoningEffort: null }]
  ])('rejects a %s write', async (_name, raw) => {
    const { service, execute } = fixture(managed);
    await expect(service.write(7, raw)).rejects.toThrow('MAR_AGENT_COMPACT_CONFIG_INVALID');
    expect(execute.mock.calls.filter(([sql]) => sql.startsWith('INSERT'))).toHaveLength(0);
  });

  it.each(['object', 'text', 'buffer'] as const)(
    'projects the runtime configuration from authorized models and a stored %s',
    async (shape) => {
      const { service, settings } = fixture(managed);
      const configuration = { enabled: true, modelId: 'coding-compact', reasoningEffort: 'high' };
      settings.set(
        'mar_agent_compact',
        shape === 'object'
          ? configuration
          : shape === 'buffer'
            ? Buffer.from(JSON.stringify(configuration))
            : JSON.stringify(configuration)
      );
      const prepared = [
        {
          id: 'coding-compact',
          name: 'Coding',
          protocol: 'ANTHROPIC_MESSAGES',
          enabled: true,
          reasoningEfforts: ['low', 'medium', 'high'],
          defaultReasoningEffort: 'medium'
        }
      ];
      await expect(service.runtime(prepared)).resolves.toEqual({
        model: prepared[0],
        reasoningEffort: 'high'
      });
    }
  );

  it.each([
    ['stored invalid', 'not-json', undefined],
    [
      'stored disabled',
      JSON.stringify({ enabled: false, modelId: 'coding-compact', reasoningEffort: 'high' }),
      []
    ],
    [
      'model missing from prepared',
      JSON.stringify({ enabled: true, modelId: 'coding-compact', reasoningEffort: 'high' }),
      []
    ],
    [
      'prepared model disabled',
      JSON.stringify({ enabled: true, modelId: 'coding-compact', reasoningEffort: 'high' }),
      [
        {
          id: 'coding-compact',
          enabled: false,
          reasoningEfforts: ['high'],
          defaultReasoningEffort: 'high'
        }
      ]
    ],
    [
      'prepared effort mismatch',
      JSON.stringify({ enabled: true, modelId: 'coding-compact', reasoningEffort: 'high' }),
      [
        {
          id: 'coding-compact',
          enabled: true,
          reasoningEfforts: ['low'],
          defaultReasoningEffort: 'low'
        }
      ]
    ]
  ])(
    'returns undefined for the runtime payload when the store is %s',
    async (_name, stored, prepared) => {
      const { service, settings } = fixture(managed);
      settings.set('mar_agent_compact', stored);
      await expect(service.runtime(prepared ?? [])).resolves.toBeUndefined();
    }
  );
});
