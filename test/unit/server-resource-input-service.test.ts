import { describe, expect, it, vi } from 'vitest';
import { MarAgentResourceInputService } from '../../packages/server-core/src/mar-agent-resource-input-service.js';

const globalKey = 'mar_agent_resource_input';
const modelKey = (id: string) => `${globalKey}:model:${id}`;

function createFixture(initial: readonly (readonly [string, string])[] = []) {
  const settings = new Map(initial);
  const execute = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    if (sql.startsWith('SELECT setting_value FROM system_settings')) {
      const value = settings.get(String(values[0]));
      return [[...(value === undefined ? [] : [{ setting_value: value }])], []];
    }
    if (sql.startsWith('SELECT setting_key,setting_value FROM system_settings')) {
      const rows = values.flatMap((key) => {
        const settingKey = String(key);
        const value = settings.get(settingKey);
        return value === undefined ? [] : [{ setting_key: settingKey, setting_value: value }];
      });
      return [rows, []];
    }
    if (sql.startsWith('INSERT INTO system_settings')) {
      settings.set(String(values[0]), String(values[1]));
      return [{ affectedRows: 1 }, []];
    }
    if (sql.startsWith('DELETE FROM system_settings')) {
      settings.delete(String(values[0]));
      return [{ affectedRows: 1 }, []];
    }
    throw new Error(`Unexpected SQL in fake executor: ${sql}`);
  });
  const database = { raw: { execute } } as unknown as ConstructorParameters<
    typeof MarAgentResourceInputService
  >[0];
  return {
    database,
    execute,
    settings,
    service: new MarAgentResourceInputService(database)
  };
}

describe('MarAgentResourceInputService', () => {
  it('defaults global settings to URL mode and model settings to inline mode', async () => {
    const { execute, service } = createFixture();

    await expect(service.read()).resolves.toEqual({ useResourceUrl: true });
    await expect(service.models([])).resolves.toEqual(new Map());
    await expect(service.models(['model-a', 'model-b'])).resolves.toEqual(
      new Map([
        ['model-a', { useResourceUrl: false }],
        ['model-b', { useResourceUrl: false }]
      ])
    );

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenNthCalledWith(
      1,
      'SELECT setting_value FROM system_settings WHERE setting_key=?',
      [globalKey]
    );
    expect(execute).toHaveBeenNthCalledWith(
      2,
      'SELECT setting_key,setting_value FROM system_settings WHERE setting_key IN (?,?)',
      [modelKey('model-a'), modelKey('model-b')]
    );
  });

  it('reads model overrides in one batch and keeps missing models at the false default', async () => {
    const { execute, service } = createFixture([
      [modelKey('model-a'), JSON.stringify({ useResourceUrl: true })],
      [modelKey('model-b'), JSON.stringify({ useResourceUrl: false })]
    ]);

    const result = await service.models(['model-a', 'model-b', 'model-missing']);

    expect(result).toEqual(
      new Map([
        ['model-a', { useResourceUrl: true }],
        ['model-b', { useResourceUrl: false }],
        ['model-missing', { useResourceUrl: false }]
      ])
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1]).toEqual([
      modelKey('model-a'),
      modelKey('model-b'),
      modelKey('model-missing')
    ]);
  });

  it('writes global and model settings to independent keys, including explicit false', async () => {
    const { database, service, settings } = createFixture();

    await service.write({ useResourceUrl: true });
    await service.write({ useResourceUrl: false }, database.raw, 'model-a');

    expect(settings.get(globalKey)).toBe(JSON.stringify({ useResourceUrl: true }));
    expect(settings.get(modelKey('model-a'))).toBe(JSON.stringify({ useResourceUrl: false }));
    await expect(service.read()).resolves.toEqual({ useResourceUrl: true });
    await expect(service.models(['model-a'])).resolves.toEqual(
      new Map([['model-a', { useResourceUrl: false }]])
    );
  });

  it('maps invalid JSON in global and model settings to the stable error code', async () => {
    const { service } = createFixture([
      [globalKey, '{invalid-json'],
      [modelKey('model-a'), '{invalid-json']
    ]);

    await expect(service.read()).rejects.toMatchObject({
      message: 'MAR_AGENT_RESOURCE_INPUT_INVALID'
    });
    await expect(service.models(['model-a'])).rejects.toMatchObject({
      message: 'MAR_AGENT_RESOURCE_INPUT_INVALID'
    });
  });

  it('removes only the selected model key', async () => {
    const { database, execute, service, settings } = createFixture([
      [globalKey, JSON.stringify({ useResourceUrl: true })],
      [modelKey('model-a'), JSON.stringify({ useResourceUrl: true })],
      [modelKey('model-b'), JSON.stringify({ useResourceUrl: false })]
    ]);

    await service.remove('model-a', database.raw);

    expect(settings.has(modelKey('model-a'))).toBe(false);
    expect(settings.get(globalKey)).toBe(JSON.stringify({ useResourceUrl: true }));
    expect(settings.get(modelKey('model-b'))).toBe(JSON.stringify({ useResourceUrl: false }));
    expect(execute).toHaveBeenCalledWith('DELETE FROM system_settings WHERE setting_key=?', [
      modelKey('model-a')
    ]);
  });
});
