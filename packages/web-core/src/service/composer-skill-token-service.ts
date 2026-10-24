import { ref, type Ref } from 'vue';
import type { ComposerSkillToken } from '../model/workbench.js';
import type { EffectiveWorkspaceSkill } from './effective-workspace-skill-service.js';
import {
  serializeComposerTag,
  COMPOSER_SKILL_INSTRUCTION,
  type ComposerFileReference
} from '@myagentroam/protocol';

export type { ComposerSkillToken } from '../model/workbench.js';

export const COMPOSER_SKILL_TOKEN_PLACEHOLDER = '\uFFFC';

export function createComposerSkillTokenService(
  target?: Ref<readonly ComposerSkillToken[]>,
  initial: readonly ComposerSkillToken[] = []
) {
  const tokens = target ?? ref<readonly ComposerSkillToken[]>(initial);

  function select(skill: EffectiveWorkspaceSkill): boolean {
    if (tokens.value.some((token) => token.name === skill.name)) return false;
    const token = {
      name: skill.name,
      source: skill.source,
      skillFilePath: skill.skillFilePath,
      available: true
    } as const;
    tokens.value = [...tokens.value, token];
    return true;
  }

  function remove(name: string): void {
    tokens.value = tokens.value.filter((token) => token.name !== name);
  }

  function clear(): void {
    tokens.value = [];
  }

  function restore(restored: readonly ComposerSkillToken[]): void {
    tokens.value = restored.filter(validToken);
  }

  function reconcile(skills: readonly EffectiveWorkspaceSkill[]): void {
    const current = new Map(skills.map((skill) => [skill.name, skill]));
    tokens.value = tokens.value.map((token) => {
      const skill = current.get(token.name);
      return skill === undefined
        ? { ...token, available: false }
        : {
            name: skill.name,
            source: skill.source,
            skillFilePath: skill.skillFilePath,
            available: true
          };
    });
  }

  return { tokens, select, remove, clear, restore, reconcile };
}

export function serializeComposerMessage(
  tokens: readonly ComposerSkillToken[],
  body: string,
  references: readonly ComposerFileReference[] = []
): string {
  return [
    body,
    tokens.length > 0
      ? serializeComposerTag('mar_skills', {
          action: 'use',
          instruction: COMPOSER_SKILL_INSTRUCTION,
          skills: tokens.map((token) => ({
            name: token.name,
            source: token.source,
            path: token.skillFilePath
          }))
        })
      : '',
    references.length > 0
      ? serializeComposerTag('mar_references', { references: [...references] })
      : ''
  ]
    .filter((part) => part.length > 0)
    .join('\n')
    .trim();
}

export function hasUnavailableSkillToken(tokens: readonly ComposerSkillToken[]): boolean {
  return tokens.some((token) => !token.available);
}

export function normalizeComposerSkillTokens(value: unknown): readonly ComposerSkillToken[] {
  return Array.isArray(value) ? value.filter(validToken) : [];
}

function validToken(value: unknown): value is ComposerSkillToken {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    typeof value.name === 'string' &&
    value.name.length > 0 &&
    'source' in value &&
    (value.source === 'NODE_HOME' || value.source === 'WORKSPACE') &&
    'skillFilePath' in value &&
    typeof value.skillFilePath === 'string' &&
    value.skillFilePath.length > 0 &&
    'available' in value &&
    typeof value.available === 'boolean'
  );
}

export type ComposerSkillTokenRef = Ref<readonly ComposerSkillToken[]>;
