import { describe, expect, it, vi } from 'vitest';
import { XAI_SUBSCRIPTION_BASE_URL } from '@myagentroam/protocol';
import {
  ModelSettingsStore,
  modelSettingsKey,
  parseModelSettings,
  parseStoredModelSettings,
  validateModelSettingsTarget
} from '../../src/model-settings.js';

describe('model settings documents', () => {
  it('keeps the full model identifier in its unique setting key', () => {
    expect(modelSettingsKey('a'.repeat(128))).toBe(`mar_agent_model_config:${'a'.repeat(128)}`);
  });

  it('accepts only the document belonging to the model protocol', () => {
    expect(parseModelSettings('ANTHROPIC_MESSAGES', { version: 1 })).toEqual({ version: 1 });
    expect(
      parseModelSettings('OPENAI_RESPONSES', {
        version: 1,
        hostedWebSearch: false,
        serviceTier: 'priority',
        responsesTransport: { transport: 'HTTP', httpVersion: '2' },
        responsesPreviousResponseId: true
      })
    ).toMatchObject({ serviceTier: 'priority' });
    for (const document of [
      { version: 2 },
      { version: 1, protocol: 'ANTHROPIC_MESSAGES' },
      { version: 1, hostedWebSearch: false },
      { version: 1, extra: true }
    ])
      expect(() => parseModelSettings('ANTHROPIC_MESSAGES', document)).toThrow(
        'MAR_AGENT_MODEL_CONFIG_INVALID'
      );
    expect(() =>
      parseModelSettings('OPENAI_RESPONSES', {
        version: 1,
        hostedWebSearch: false,
        responsesPreviousResponseId: false,
        responsesTransport: { transport: 'WEBSOCKET', extra: true }
      })
    ).toThrow('MAR_AGENT_MODEL_CONFIG_INVALID');
    expect(() => parseModelSettings('INVALID' as never, { version: 1 })).toThrow(
      'MAR_AGENT_MODEL_CONFIG_INVALID'
    );
  });

  it('decodes selected documents, rejects missing or malformed settings and writes on the supplied executor', async () => {
    const executor = {
      execute: vi.fn(async () => [
        [{ setting_key: modelSettingsKey('a'), setting_value: '{"version":1}' }],
        []
      ])
    };
    const store = new ModelSettingsStore(() => 42);
    expect(parseStoredModelSettings('ANTHROPIC_MESSAGES', '{"version":1}')).toEqual({ version: 1 });
    expect(parseStoredModelSettings('ANTHROPIC_MESSAGES', Buffer.from('{"version":1}'))).toEqual({
      version: 1
    });
    expect(() => parseStoredModelSettings('ANTHROPIC_MESSAGES', undefined)).toThrow(
      'MAR_AGENT_MODEL_CONFIG_INVALID'
    );
    expect(() => parseStoredModelSettings('ANTHROPIC_MESSAGES', '{')).toThrow(
      'MAR_AGENT_MODEL_CONFIG_INVALID'
    );
    await store.write('a', 'ANTHROPIC_MESSAGES', { version: 1 }, executor as never);
    expect(executor.execute).toHaveBeenLastCalledWith(
      expect.stringContaining('INSERT INTO system_settings'),
      [modelSettingsKey('a'), '{"version":1}', 42]
    );
    await store.remove('a', executor as never);
    expect(executor.execute).toHaveBeenLastCalledWith(
      'DELETE FROM system_settings WHERE setting_key=?',
      [modelSettingsKey('a')]
    );
  });
  it('preserves credential target constraints', () => {
    const credential = { type: 'CREDENTIAL_REF', credentialId: 'credential' };
    const settings = parseModelSettings('OPENAI_RESPONSES', {
      version: 1,
      hostedWebSearch: false,
      serviceTier: 'default',
      responsesPreviousResponseId: false,
      responsesTransport: { transport: 'HTTP', httpVersion: '1.1' }
    });
    expect(() =>
      validateModelSettingsTarget(
        'OPENAI_RESPONSES',
        XAI_SUBSCRIPTION_BASE_URL,
        credential,
        settings
      )
    ).not.toThrow();
    const badSpeed = parseModelSettings('OPENAI_RESPONSES', {
      version: 1,
      hostedWebSearch: false,
      serviceTier: 'priority',
      responsesPreviousResponseId: false,
      responsesTransport: { transport: 'HTTP', httpVersion: '1.1' }
    });
    expect(() =>
      validateModelSettingsTarget(
        'OPENAI_RESPONSES',
        XAI_SUBSCRIPTION_BASE_URL,
        credential,
        badSpeed
      )
    ).toThrow('MAR_AGENT_MODEL_CONFIG_INVALID');
    expect(() =>
      validateModelSettingsTarget('OPENAI_RESPONSES', 'https://example.test', credential, settings)
    ).toThrow('MAR_AGENT_MODEL_CONFIG_INVALID');
    expect(() =>
      validateModelSettingsTarget('ANTHROPIC_MESSAGES', 'https://example.test', credential, {
        version: 1
      })
    ).toThrow('MAR_AGENT_MODEL_CONFIG_INVALID');
  });
});
