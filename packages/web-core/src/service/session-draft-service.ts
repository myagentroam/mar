import { ref, type Ref } from 'vue';
import type { ComposerSkillToken, WorkspaceTarget } from '../model/workbench.js';
import type { ComposerFileReference } from '@myagentroam/protocol';
import { normalizeComposerReferences } from './file-reference-service.js';
import {
  COMPOSER_SKILL_TOKEN_PLACEHOLDER,
  normalizeComposerSkillTokens
} from './composer-skill-token-service.js';

export function createSessionDraftService(options: {
  readonly workspaceTarget: Readonly<Ref<WorkspaceTarget | undefined>>;
  readonly storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
}) {
  const input = ref('');
  const skillTokens = ref<readonly ComposerSkillToken[]>([]);
  const references = ref<readonly ComposerFileReference[]>([]);
  const storage = options.storage ?? sessionStorage;

  function key(): string | undefined {
    const workspace = options.workspaceTarget.value;
    return workspace === undefined
      ? undefined
      : `mar.workbench.draft.${workspace.nodeId}.${workspace.workspaceId}`;
  }

  function restore(): void {
    const storageKey = key();
    if (storageKey === undefined) return;
    try {
      const stored = storage.getItem(storageKey);
      if (stored === null) {
        input.value = '';
        skillTokens.value = [];
        references.value = [];
        return;
      }
      try {
        const parsed = JSON.parse(stored) as {
          input?: unknown;
          skillTokens?: unknown;
          references?: unknown;
        };
        references.value = normalizeComposerReferences(parsed.references);
        const restoredInput = typeof parsed.input === 'string' ? parsed.input : '';
        const restoredTokens = normalizeComposerSkillTokens(parsed.skillTokens).map((token) => ({
          ...token,
          available: false
        }));
        const placeholderCount = [...restoredInput].filter(
          (character) => character === COMPOSER_SKILL_TOKEN_PLACEHOLDER
        ).length;
        skillTokens.value =
          placeholderCount > 0 ? restoredTokens.slice(0, placeholderCount) : restoredTokens;
        input.value = restoredInput.replaceAll(COMPOSER_SKILL_TOKEN_PLACEHOLDER, '');
      } catch {
        input.value = stored;
        skillTokens.value = [];
        references.value = [];
      }
    } catch {
      input.value = '';
      skillTokens.value = [];
      references.value = [];
    }
  }

  function persist(): void {
    const storageKey = key();
    if (storageKey === undefined) return;
    try {
      if (
        input.value.length === 0 &&
        skillTokens.value.length === 0 &&
        references.value.length === 0
      )
        storage.removeItem(storageKey);
      else
        storage.setItem(
          storageKey,
          JSON.stringify({
            input: input.value,
            skillTokens: skillTokens.value,
            references: references.value
          })
        );
    } catch {
      // Drafts are a local convenience only.
    }
  }

  return { input, skillTokens, references, restore, persist, key };
}
