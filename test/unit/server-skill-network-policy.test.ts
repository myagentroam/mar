import { describe, expect, it, vi } from 'vitest';
import type { MysqlServerDatabase } from '../../ee/server/src/mysql/server-database.js';
import {
  isPublicAddress,
  SkillNetworkPolicy
} from '../../ee/server/src/skill/skill-network-policy.js';

describe('Server Skill TLS policy', () => {
  it('Certificate verification stays enabled by default and risky opt-outs are explicitly persisted', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      .mockResolvedValueOnce([[{ setting_value: 'true' }], []]);
    const policy = new SkillNetworkPolicy({ raw: { execute } } as unknown as MysqlServerDatabase);

    await expect(policy.disabled()).resolves.toBe(false);
    await policy.setDisabled(true);
    await expect(policy.disabled()).resolves.toBe(true);
    expect(execute.mock.calls[1]?.[1]).toEqual([
      'skill_tls_verification_disabled',
      'true',
      expect.any(Number)
    ]);
  });

  it('Rejects local, private, link-local, and documentation-reserved addresses', () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '192.168.1.1',
      '192.0.2.1',
      '::1',
      'fc00::1',
      'fe80::1',
      '2001:db8::1',
      '::ffff:127.0.0.1'
    ])
      expect(isPublicAddress(address), address).toBe(false);
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
  });
});
