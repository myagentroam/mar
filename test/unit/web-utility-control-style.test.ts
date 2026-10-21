import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readSource = (path: string) => readFile(resolve(process.cwd(), path), 'utf8');

function declarationsFor(source: string, selector: string): readonly string[] {
  return [...source.matchAll(new RegExp(`${selector}\\s*\\{([^}]*)\\}`, 'gu'))]
    .map((match) => match[1])
    .filter((declarations): declarations is string => declarations !== undefined);
}

describe('Web Workbench utility control styles', () => {
  it('uses foreground-only brand highlighting for the approved global and inline utility controls', async () => {
    const [globalStyles, header, sessionList, workspaceInspector] = await Promise.all([
      readSource('packages/web-core/src/styles.css'),
      readSource('packages/web-core/src/view/workbench/WorkbenchHeader.vue'),
      readSource('packages/web-core/src/view/workspace/WorkspaceSessionList.vue'),
      readSource('packages/web-core/src/view/workspace/WorkspaceInspector.vue')
    ]);

    expect(globalStyles).toMatch(
      /\.utility-control\s*\{\s*background:\s*transparent;\s*color:\s*var\(--mar-text-secondary\);/u
    );
    expect(globalStyles).toMatch(
      /\.utility-control:hover:not\(:disabled\),\s*\.utility-control:focus-visible,\s*\.utility-control\.is-active,\s*\.utility-control\[aria-expanded='true'\]\s*\{\s*background:\s*transparent;\s*color:\s*var\(--mar-color-brand-text\);/u
    );
    expect(globalStyles).toMatch(
      /\.utility-control:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--mar-color-brand\);/u
    );
    expect(globalStyles).toMatch(
      /\.utility-control\.el-button\s*\{[^}]*--el-button-bg-color:\s*transparent;[^}]*--el-button-border-color:\s*transparent;[^}]*--el-button-hover-bg-color:\s*transparent;[^}]*--el-button-hover-border-color:\s*transparent;[^}]*--el-button-active-bg-color:\s*transparent;[^}]*--el-button-active-border-color:\s*transparent;[^}]*--el-fill-color-light:\s*transparent;[^}]*--el-fill-color:\s*transparent;[^}]*--el-fill-color-dark:\s*transparent;/u
    );
    expect(globalStyles).toMatch(
      /\.utility-control\.el-button,\s*\.utility-control\.el-button:hover:not\(:disabled\),\s*\.utility-control\.el-button:active:not\(:disabled\),\s*\.utility-control\.el-button\.is-active,\s*\.utility-control\.el-button:focus-visible,\s*\.utility-control\.el-button\[aria-expanded='true'\]\s*\{\s*background-color:\s*transparent !important;\s*border-color:\s*transparent !important;/u
    );

    expect(header).toContain('class="workbench-tree-toggle icon-button utility-control"');
    expect(header).toContain("import { Expand, Fold } from '@element-plus/icons-vue';");
    expect(header).toContain('<el-icon v-if="sidebarCollapsed"><Expand /></el-icon>');
    expect(header).toContain('<el-icon v-else><Fold /></el-icon>');
    expect(
      declarationsFor(
        header,
        "\\.workbench-tree-toggle\\[aria-expanded='true'\\]:not\\(:hover\\):not\\(:focus-visible\\)"
      )
    ).toEqual([expect.stringMatching(/color:\s*var\(--mar-text-secondary\);/u)]);
    expect(sessionList).toMatch(/<button\s+class="session-search-button utility-control"/u);
    expect(sessionList).toMatch(/<button\s+class="workspace-more-button utility-control"/u);
    expect(sessionList).toMatch(
      /<el-icon v-if="searching \|\| refreshing" class="is-loading"><Loading\s*\/><\/el-icon>\s*<el-icon v-else><Refresh\s*\/><\/el-icon>/u
    );
    expect(sessionList.match(/class="session-more-button utility-control"/gu)).toHaveLength(1);
    expect(
      workspaceInspector.match(/<button\s+class="file-explorer-utility-button utility-control"/gu)
    ).toHaveLength(2);
    expect(workspaceInspector).toMatch(
      /<button(?=[^>]*class="content-search-button file-explorer-utility-button utility-control")/u
    );
    expect(workspaceInspector).toMatch(
      /<button(?=[^>]*class="changes-refresh-button file-explorer-utility-button utility-control")/u
    );
    expect(workspaceInspector).toMatch(
      /<button(?=[^>]*class="history-refresh file-explorer-utility-button utility-control")/u
    );
    expect(workspaceInspector).toMatch(
      /<el-button\s+class="change-restore utility-control"[\s\S]*?:icon="RefreshLeft"/u
    );
    for (const [icon, loading] of [
      ['Refresh', 'filesBusy'],
      ['DocumentAdd', 'preparingUploads'],
      ['Search', 'contentSearchLoading'],
      ['Refresh', 'changesRefreshing'],
      ['Refresh', 'historyLoading']
    ] as const)
      expect(workspaceInspector).toMatch(
        new RegExp(
          `<el-icon v-if="${loading}" class="is-loading"><Loading\\s*/></el-icon>\\s*<el-icon v-else><${icon}\\s*/></el-icon>`,
          'u'
        )
      );
    expect(
      declarationsFor(
        sessionList,
        '\\.session-search \\.session-search-button:hover:not\\(:disabled\\),\\s*\\.session-search \\.session-search-button:focus-visible,\\s*\\.new-session-form \\.workspace-more-button:hover:not\\(:disabled\\),\\s*\\.new-session-form \\.workspace-more-button:focus-visible'
      )
    ).toEqual([
      expect.stringMatching(
        /background:\s*transparent;[\s\S]*color:\s*var\(--mar-color-brand-text\);/u
      )
    ]);
    expect(workspaceInspector).toContain(':global(.explorer-toolbar .el-button) {');
    expect(workspaceInspector).toMatch(
      /button\.file-explorer-utility-button\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent;[^}]*color:\s*var\(--mar-text-secondary\);[^}]*cursor:\s*pointer;/u
    );
    expect(workspaceInspector).not.toContain(
      ':global(.explorer-toolbar .el-button.utility-control)'
    );
    expect(workspaceInspector).not.toContain(
      ':global(.explorer-toolbar .el-button:hover:not(:disabled)),'
    );
    expect(workspaceInspector).not.toMatch(
      /<el-button[\s\S]*?:loading="contentSearchLoading"[\s\S]*?native-type="submit"/u
    );
    expect(workspaceInspector).not.toMatch(
      /<el-button[\s\S]*?:loading="changesRefreshing"[\s\S]*?@click="loadChanges\(\)"/u
    );
    expect(workspaceInspector).not.toMatch(
      /<el-button[\s\S]*?class="history-refresh"[\s\S]*?:loading="historyLoading"/u
    );
    expect(sessionList).not.toContain('.new-session-form > .el-dropdown {');
    expect(workspaceInspector).toMatch(
      /@media \(max-width: 767px\)[\s\S]*?button\.file-explorer-utility-button\s*\{[^}]*width:\s*36px;[^}]*min-width:\s*36px;[^}]*height:\s*36px;[^}]*min-height:\s*36px;/u
    );
    expect(sessionList).toMatch(
      /@media \(max-width: 767px\)[\s\S]*?\.session-search \.session-search-button,\s*\.new-session-form \.workspace-more-button\s*\{[^}]*width:\s*36px;[^}]*min-width:\s*36px;[^}]*height:\s*36px;[^}]*min-height:\s*36px;/u
    );
  });
});
