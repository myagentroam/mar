import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { i18n } from '../../src/service/locale-preference-service.js';

describe.each(['zh-CN', 'en-US'] as const)('workspace tool messages in %s', (locale) => {
  it('resolves every fixed message used by the independent tools and file workbench', () => {
    const sources = [
      '../../src/view/workbench/WorkbenchSurface.vue',
      '../../src/view/workspace/WorkspaceFilesPanel.vue',
      '../../src/view/workspace/WorkspaceContentSearch.vue',
      '../../src/view/workspace/WorkspaceGitChanges.vue',
      '../../src/view/workspace/WorkspaceGitHistory.vue',
      '../../src/view/workspace/WorkspaceFileWorkbench.vue'
    ].map((file) => readFileSync(new URL(file, import.meta.url), 'utf8'));
    const keys = new Set(
      sources.flatMap((source) =>
        [
          ...source.matchAll(
            /'((?:generated|gitWorktrees|gitSync|workspaceWatch|workspaceDisplayFilter)\.[\w.-]+)'/gu
          )
        ].map((match) => match[1]!)
      )
    );
    expect(keys.size).toBeGreaterThan(100);
    for (const key of keys) expect(i18n.global.te(key, locale), key).toBe(true);
  });
});
