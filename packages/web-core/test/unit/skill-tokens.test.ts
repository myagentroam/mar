import { describe, expect, it, vi } from 'vitest';
import { createEffectiveWorkspaceSkillService } from '../../src/service/EffectiveWorkspaceSkillService.js';
import {
  createComposerSkillTokenService,
  serializeComposerMessage,
  hasUnavailableSkillToken,
  normalizeComposerSkillTokens
} from '../../src/service/ComposerSkillTokenService.js';

const skill = {
  name: 'read-code',
  description: 'Read code',
  localStatus: 'INSTALLED',
  source: 'WORKSPACE' as const,
  skillFilePath: '/work/.agents/skills/read-code/SKILL.md'
};

describe('Public Effective Skills and Composer Tokens', () => {
  it('Requests only ordinary Workspace skill projections, preserves loaded results on failure, and ends loading', async () => {
    const request = vi.fn().mockResolvedValue({ skills: [skill] });
    const service = createEffectiveWorkspaceSkillService(request);
    await service.load('node/a', 'workspace/b');
    expect(request).toHaveBeenCalledWith(
      '/api/workspaces/workspace%2Fb/effective-skills?nodeId=node%2Fa'
    );
    expect(service.skills.value).toEqual([skill]);
    request.mockRejectedValue(new Error('offline'));
    await expect(service.load('node/a', 'workspace/b')).rejects.toThrow('offline');
    expect(service.loading.value).toBe(false);
    expect(service.skills.value).toEqual([skill]);
  });

  it('Preserves order across deduplication, invalidation, and reconciliation while using the latest skill path', () => {
    const service = createComposerSkillTokenService();
    expect(service.select(skill)).toBe(true);
    expect(service.select(skill)).toBe(false);
    service.reconcile([]);
    expect(hasUnavailableSkillToken(service.tokens.value)).toBe(true);
    service.reconcile([{ ...skill, skillFilePath: '/new/SKILL.md' }]);
    expect(hasUnavailableSkillToken(service.tokens.value)).toBe(false);
    expect(serializeComposerMessage(service.tokens.value, 'body')).toBe(
      '[invoke skill](</new/SKILL.md>)\nbody'
    );
    service.remove(skill.name);
    expect(service.tokens.value).toEqual([]);
    service.select(skill);
    service.clear();
    expect(service.tokens.value).toEqual([]);
  });

  it('Filters malformed tokens, escapes paths, and does not parse user text as a skill command', () => {
    const token = { ...skill, available: false, skillFilePath: 'C:\\work>\\SKILL.md' };
    expect(normalizeComposerSkillTokens([null, {}, token])).toEqual([token]);
    expect(normalizeComposerSkillTokens({})).toEqual([]);
    const service = createComposerSkillTokenService();
    service.restore([token]);
    expect(serializeComposerMessage(service.tokens.value, 'free text')).toBe(
      '[invoke skill](<C:\\\\work\\>\\\\SKILL.md>)\nfree text'
    );
  });
});
