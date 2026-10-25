import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import type { NodeWorkspace } from '../../mar-node/src/database.js';
import { inspectWorkspace } from '../../mar-node/src/workspace.js';
import { WorkspaceDomainState } from '../../mar-node/src/service/workspace-domain-state.js';
import { WorkspaceChangeService } from '../../mar-node/src/service/workspace-change-service.js';
import { WorkspaceFileService } from '../../mar-node/src/service/workspace-file-service.js';
import { WorkspaceUploadService } from '../../mar-node/src/service/workspace-upload-service.js';
import { WorkspaceWatchService } from '../../mar-node/src/service/workspace-watch-service.js';
import { WorkspaceWorkbenchService } from '../../mar-node/src/service/workspace-workbench-service.js';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

const execute = promisify(execFile);

for (const crossNode of [false, true]) {
  test(`Git cache recovery and real restore isolate ${crossNode ? 'Nodes sharing a Workspace ID' : 'Workspaces on one Node'}`, async ({
    page
  }, testInfo) => {
    test.setTimeout(90_000);
    const root = await mkdtemp(join(tmpdir(), 'mar-git-target-isolation-'));
    const targets = [
      { nodeId: 'node-a', workspaceId: 'workspace-a' },
      {
        nodeId: crossNode ? 'node-b' : 'node-a',
        workspaceId: crossNode ? 'workspace-a' : 'workspace-b'
      }
    ];
    const registrations = new Map<string, NodeWorkspace>();
    const services = new Map<string, WorkspaceWorkbenchService>();
    const changeServices = new Map<string, WorkspaceChangeService>();
    const files: WorkspaceFileService[] = [];
    const linkedPath = join(root, 'B-linked');
    const requests: { url: string; body: Record<string, unknown> }[] = [];
    let releaseRefresh: (() => void) | undefined;
    let holdRefresh = false;
    let heldRefresh = false;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const fixture = await startCustomThemeFixture('test/e2e/support/git-target-isolation.html');
    try {
      for (const [index, name] of ['A', 'B'].entries()) {
        const directory = join(root, name);
        await mkdir(directory);
        await writeFile(join(directory, 'same.txt'), `${name} original\n`);
        for (const args of [
          ['init', '-b', 'main'],
          ['config', 'user.name', 'Fixture'],
          ['config', 'user.email', 'fixture@example.invalid'],
          ['add', '.'],
          ['commit', '-m', 'fixture']
        ])
          await execute('git', args, { cwd: directory });
        if (name === 'B') {
          await execute('git', ['worktree', 'add', '-b', 'linked', linkedPath], { cwd: directory });
          await writeFile(join(linkedPath, 'same.txt'), 'B linked modified\n');
        }
        await writeFile(join(directory, 'same.txt'), `${name} modified\n`);
        await writeFile(join(directory, `${name.toLowerCase()}-only.txt`), `${name} untracked\n`);
        const target = targets[index]!;
        const inspection = await inspectWorkspace(directory, [root]);
        registrations.set(`${target.nodeId}:${target.workspaceId}`, {
          id: target.workspaceId,
          ...inspection,
          gitSummary: inspection.gitSummary ?? null
        });
      }
      for (const nodeId of new Set(targets.map((target) => target.nodeId))) {
        const state = new WorkspaceDomainState();
        const changes = new WorkspaceChangeService(state);
        changeServices.set(nodeId, changes);
        const fileService = new WorkspaceFileService(state, () => {});
        files.push(fileService);
        services.set(
          nodeId,
          new WorkspaceWorkbenchService({
            requireWorkspace: (id) => {
              const workspace = registrations.get(`${nodeId}:${String(id)}`);
              if (!workspace) throw new Error('WORKSPACE_NOT_FOUND');
              return workspace;
            },
            inspectWorkspace: (workspace) => inspectWorkspace(workspace.path, [root]),
            commitWorkspace: async (workspace) => workspace,
            changes,
            files: fileService,
            uploads: new WorkspaceUploadService(
              state,
              () => {},
              () => root
            ),
            watch: new WorkspaceWatchService(
              state,
              () => {},
              () => {},
              () => {}
            ),
            listSessions: async () => ({ sessions: [] }),
            invalidate: (id) => changes.invalidate(id),
            nodeId: () => nodeId,
            nodeGeneration: () => 'fixture-generation',
            emitWatchEvent: () => {}
          })
        );
      }

      // HTTP routing/auth/Server relay and Watch delivery are controlled boundaries.
      // Git reads, target resolution, restore validation and destructive Git work
      // execute the unmodified product Node operation handlers against our registry.
      await page.route('**/fixture/**', async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === '/fixture/targets') return route.fulfill({ json: targets });
        const nodeId = url.searchParams.get('nodeId')!;
        const workspaceId = url.searchParams.get('workspaceId')!;
        const value = await services.get(nodeId)!.operations()['workspace.changes.current']!({
          workspaceId
        });
        await route.fulfill({ json: value });
      });
      await page.route('**/api/workspaces/**', async (route) => {
        const url = new URL(route.request().url());
        const workspaceId = decodeURIComponent(url.pathname.split('/')[3]!);
        const nodeId = url.searchParams.get('nodeId')!;
        const workspace = registrations.get(`${nodeId}:${workspaceId}`);
        expect(workspace).toBeDefined();
        const operations = services.get(nodeId)!.operations();
        if (url.pathname.endsWith('/changes/restore')) {
          const body = route.request().postDataJSON() as Record<string, unknown>;
          requests.push({ url: url.href, body });
          // Audit the exact disposable registry/path before any actual discard.
          expect(await realpath(root)).toBe(root);
          expect(await realpath(workspace!.path)).toBe(join(root, 'B'));
          expect({ nodeId, workspaceId }).toEqual(targets[1]);
          expect(body.nodeId).toBe(nodeId);
          if (body.worktreePath !== undefined) expect(body.worktreePath).toBe(linkedPath);
          const result = await operations['workspace.change.restore']!({ ...body, workspaceId });
          return route.fulfill({ json: result });
        }
        const operation = url.pathname.endsWith('/changes')
          ? 'workspace.changes.current'
          : 'workspace.files.list';
        const result = await operations[operation]!({ workspaceId });
        if (
          holdRefresh &&
          operation === 'workspace.changes.current' &&
          workspaceId === targets[1]!.workspaceId &&
          nodeId === targets[1]!.nodeId
        ) {
          heldRefresh = true;
          await refreshGate;
        }
        await route.fulfill({ json: result });
      });
      await page.goto(`${fixture.url}git-target-isolation.html`);
      const status = page.getByTestId('status');
      await page.getByRole('button', { name: 'Select B', exact: true }).click();
      await expect(status).toHaveText('selected-1');
      await page.getByRole('button', { name: 'Watch B:1', exact: true }).click();
      await expect(status).toHaveText('watch-1-1');
      await page.getByRole('tab', { name: 'Git Changes', exact: true }).click();
      const changes = page.locator('.change-list');
      await expect(changes).toContainText('b-only.txt');
      await page.getByRole('button', { name: 'Select A', exact: true }).click();
      await page.getByRole('button', { name: 'Watch A:3', exact: true }).click();
      await expect(status).toHaveText('watch-0-3');
      await page.getByRole('tab', { name: 'Git Changes', exact: true }).click();
      await expect(changes).toContainText('a-only.txt');
      holdRefresh = true;
      await page.getByRole('button', { name: 'Select B', exact: true }).click();
      await expect(status).toHaveText('selected-1');
      await expect.poll(() => heldRefresh).toBe(true);
      await expect(changes).toContainText('b-only.txt');
      await expect(changes).not.toContainText('a-only.txt');
      await writeFile(join(root, 'B', 'b-fresh.txt'), 'fresh B\n');
      // The fixture has no filesystem watcher: invalidate this target's product
      // Changes cache after the external write, then read authoritative Git data.
      changeServices.get(targets[1]!.nodeId)!.invalidate(targets[1]!.workspaceId);
      await page.getByRole('button', { name: 'Watch B:1', exact: true }).click();
      await expect(changes).toContainText('b-fresh.txt');
      await page.getByRole('button', { name: 'Old A Watch', exact: true }).click();
      await expect(status).toHaveText('watch-0-99');
      await expect(changes).not.toContainText('a-only.txt');
      await page.getByRole('button', { name: 'Low B Watch', exact: true }).click();
      releaseRefresh!();
      holdRefresh = false;
      await expect(page.locator('.changes-refresh-button')).not.toBeDisabled();
      await expect(changes).toContainText('b-fresh.txt');

      // Restore the displayed linked-worktree entry, not the identically named
      // root file in B or A. The real confirmation must name the displayed path.
      const sameRows = changes
        .locator('.change-entry')
        .filter({ has: page.locator('.change-path', { hasText: 'same.txt' }) });
      await expect(sameRows).toHaveCount(2);
      const linkedRow = sameRows.last();
      await linkedRow.locator('.change-restore').click();
      const confirm = page.getByRole('dialog');
      await expect(linkedRow.locator('.change-restore')).toHaveAttribute(
        'aria-label',
        `Revert changes to ${linkedPath}/same.txt`
      );
      await expect(confirm).toContainText(`${linkedPath}/same.txt`);
      await confirm.getByRole('button', { name: 'Revert', exact: true }).click({ trial: true });
      await page.screenshot({
        path: testInfo.outputPath('restore-confirmation.png'),
        animations: 'disabled'
      });
      await confirm.getByRole('button', { name: 'Revert', exact: true }).click();
      await expect.poll(() => requests.length).toBe(1);
      await expect.poll(() => readFile(join(linkedPath, 'same.txt'), 'utf8')).toBe('B original\n');
      expect(await readFile(join(root, 'B', 'same.txt'), 'utf8')).toBe('B modified\n');
      expect(await readFile(join(root, 'A', 'same.txt'), 'utf8')).toBe('A modified\n');
      expect(await readFile(join(root, 'A', 'a-only.txt'), 'utf8')).toBe('A untracked\n');
      expect(await readFile(join(root, 'B', 'b-only.txt'), 'utf8')).toBe('B untracked\n');
      expect(new URL(requests[0]!.url).pathname).toBe(
        `/api/workspaces/${targets[1]!.workspaceId}/changes/restore`
      );
      expect(new URL(requests[0]!.url).searchParams.get('nodeId')).toBe(targets[1]!.nodeId);
      expect(requests[0]!.body).toEqual({
        nodeId: targets[1]!.nodeId,
        path: 'same.txt',
        state: 'UNSTAGED',
        worktreePath: linkedPath
      });
      const untracked = changes
        .locator('.change-entry')
        .filter({ has: page.locator('.change-path', { hasText: 'b-only.txt' }) });
      await untracked.locator('.change-restore').click();
      await expect(confirm).toContainText('b-only.txt');
      await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
      await expect.poll(() => requests.length).toBe(2);
      await expect
        .poll(async () =>
          readFile(join(root, 'B', 'b-only.txt')).then(
            () => 'exists',
            (error: NodeJS.ErrnoException) => error.code
          )
        )
        .toBe('ENOENT');
      expect(requests[1]!.body).toEqual({
        nodeId: targets[1]!.nodeId,
        path: 'b-only.txt',
        state: 'UNTRACKED'
      });
      expect(new URL(requests[1]!.url).pathname).toBe(
        `/api/workspaces/${targets[1]!.workspaceId}/changes/restore`
      );
      expect(new URL(requests[1]!.url).searchParams.get('nodeId')).toBe(targets[1]!.nodeId);
      expect(await readFile(join(root, 'A', 'a-only.txt'), 'utf8')).toBe('A untracked\n');
      expect(await readFile(join(root, 'A', 'same.txt'), 'utf8')).toBe('A modified\n');
      expect(await readFile(join(root, 'B', 'same.txt'), 'utf8')).toBe('B modified\n');
      expect(await readFile(join(root, 'B', 'b-fresh.txt'), 'utf8')).toBe('fresh B\n');
      await testInfo.attach('target-evidence', {
        body: JSON.stringify({ root, registrations: [...registrations], requests }, null, 2),
        contentType: 'application/json'
      });
    } finally {
      releaseRefresh?.();
      await page.unrouteAll({ behavior: 'wait' });
      for (const service of services.values()) service.clear();
      for (const service of files) service.dispose();
      await fixture.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
