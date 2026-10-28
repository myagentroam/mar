import { describe, expect, it } from 'vitest';
import { XAI_SUBSCRIPTION_BASE_URL } from '@myagentroam/protocol';
import {
  MODEL_SETTINGS_MIGRATION,
  normalizeLegacyModelTier
} from '../../src/model-settings-migration.js';

it('keeps the v34 DDL and conversion specification checksum stable', () => {
  expect(MODEL_SETTINGS_MIGRATION.version).toBe(34);
  expect(MODEL_SETTINGS_MIGRATION.checksum).toBe(
    '4b93a6567cb5bb060c680680abe2c71d0749600ec2ea8418d4967fa0b1966e8b'
  );
});

describe('legacy model speed migration', () => {
  it.each([
    ['INLINE_API_KEY', false, null, undefined],
    ['CREDENTIAL_REF', false, null, 'default'],
    ['CREDENTIAL_REF', true, null, 'priority'],
    ['CREDENTIAL_REF', true, 'default', 'default'],
    ['CREDENTIAL_REF', false, 'priority', 'priority'],
    ['INLINE_API_KEY', false, 'fast', 'fast']
  ] as const)(
    'normalizes %s, old fast=%s and explicit tier=%s to %s',
    (credentialType, fastMode, serviceTier, expected) => {
      expect(
        normalizeLegacyModelTier({
          credentialType,
          fastMode,
          serviceTier,
          baseUrl: 'https://example.test'
        })
      ).toBe(expected);
    }
  );

  it('preserves existing credential and subscription target rejection', () => {
    expect(() =>
      normalizeLegacyModelTier({
        credentialType: 'INLINE_API_KEY',
        fastMode: true,
        serviceTier: 'priority',
        baseUrl: 'https://example.test'
      })
    ).toThrow('MAR_AGENT_MODEL_CONFIG_INVALID');
    expect(() =>
      normalizeLegacyModelTier({
        credentialType: 'CREDENTIAL_REF',
        fastMode: true,
        serviceTier: 'default',
        baseUrl: XAI_SUBSCRIPTION_BASE_URL
      })
    ).toThrow('MAR_AGENT_MODEL_CONFIG_INVALID');
    expect(() =>
      normalizeLegacyModelTier({
        credentialType: 'CREDENTIAL_REF',
        fastMode: false,
        serviceTier: 'priority',
        baseUrl: XAI_SUBSCRIPTION_BASE_URL
      })
    ).toThrow('MAR_AGENT_MODEL_CONFIG_INVALID');
  });
});
