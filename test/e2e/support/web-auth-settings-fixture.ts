import type { Page } from '@playwright/test';
import { json } from './web-console-api.js';

export async function mockPersonalResources(page: Page): Promise<void> {
  await page.route('**/api/resources*', (route) =>
    json(route, {
      nodes: [
        {
          id: 'node-1',
          displayName: '研发节点',
          connected: true,
          disabled: false,
          ownership: { ownerType: 'PERSONAL', ownerUserId: 1 }
        }
      ],
      workspaces: [
        {
          nodeId: 'node-1',
          workspaceId: 'workspace-1',
          ownership: { ownerType: 'PERSONAL', ownerUserId: 1 }
        }
      ],
      ...(new URL(route.request().url()).searchParams.has('page')
        ? { page: 1, pageSize: 20, total: 1, hasMore: false }
        : {})
    })
  );
}

export async function selectAppearanceOption(
  page: Page,
  field: string,
  option: string
): Promise<void> {
  await page
    .getByRole('combobox', { name: field, exact: true })
    .locator(
      'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " el-select ")][1]'
    )
    .click();
  await page.getByRole('option', { name: option, exact: true }).click();
}
