import { expect, type Page } from '@playwright/test';

interface RecordedWrite {
  readonly url: string;
  readonly body: string;
}

export async function replaceActiveHostedConversationMessage(
  page: Page,
  writes: readonly RecordedWrite[]
): Promise<void> {
  const composer = page.getByPlaceholder('发送消息给 MAR Agent');
  await composer.fill('替换当前运行。');
  await composer.press('Control+Enter');
  await expect.poll(() => writes.filter((entry) => entry.url.endsWith('/messages')).length).toBe(2);
  expect(
    JSON.parse(
      writes.filter((entry) => entry.url.endsWith('/messages'))[1]?.body ?? '{}'
    ) as Record<string, unknown>
  ).toMatchObject({
    prompt: '替换当前运行。',
    attachmentIds: [],
    modelId: 'model-1',
    deliveryIntent: 'REPLACE_CURRENT'
  });
  await expect(page.getByRole('button', { name: '停止（Esc）' })).toBeEnabled();
  await composer.press('Escape');
  await expect
    .poll(() => writes.filter((entry) => entry.url.endsWith('/interrupt')).length)
    .toBe(1);
  expect(writes.find((entry) => entry.url.endsWith('/interrupt'))?.body).toBe('{}');
}
