import { expect, test } from '@playwright/test';
import { startCustomThemeFixture } from './support/custom-theme-vite.js';

test('UUID, SHA-256, upload initialization and sharing work in a non-secure HTTP context', async ({
  page
}) => {
  const fixture = await startCustomThemeFixture('test/e2e/support/http-runtime.html');
  const upstream = new URL(fixture.url).origin;
  const origin = 'http://mar-http.example.test';
  try {
    // Proxy only the isolated fixture. The browser still sees a real non-secure HTTP origin.
    await page.route(`${origin}/**`, async (route) => {
      const response = await route.fetch({
        url: route.request().url().replace(origin, upstream),
        headers: { ...route.request().headers(), host: new URL(upstream).host }
      });
      await route.fulfill({ response });
    });
    await page.goto(`${origin}/test/e2e/support/http-runtime.html`);
    const result = await page.evaluate(async () => {
      const source = '/packages/web-core/src';
      const [
        { createUuid },
        { workspaceFileSha256 },
        { createWorkspaceUploadService },
        { createSessionShareAccessService }
      ] = await Promise.all([
        import(`${source}/util/uuid.ts`),
        import(`${source}/util/workspace-file-checksum.ts`),
        import(`${source}/service/workspace-upload-service.ts`),
        import(`${source}/service/session-share-access-service.ts`)
      ]);
      let uploadedDigest: string | undefined;
      let complete!: () => void;
      const completed = new Promise<void>((resolve) => {
        complete = resolve;
      });
      const uploads = createWorkspaceUploadService({
        workspaceTarget: { value: { nodeId: 'node', workspaceId: 'workspace' } },
        csrfToken: { value: 'fixture-csrf' },
        request: async () => {
          throw new Error('Unexpected relay request');
        },
        renewCsrfToken: async () => 'fixture-csrf',
        onFilesChanged: complete,
        direct: {
          generation: () => 'generation',
          upload: async ({ descriptor }: { descriptor: { sha256: string } }) => {
            uploadedDigest = descriptor.sha256;
          }
        }
      });
      const file = new File(['abc'], 'sample.txt');
      const checksum = await workspaceFileSha256(file);
      uploads.queue([{ file, directory: '.', overwrite: false }]);
      await completed;
      const share = createSessionShareAccessService('fixture');
      const visitorId = share.visitor.value.visitorId;
      const restored = createSessionShareAccessService('fixture');
      const result = {
        secure: isSecureContext,
        nativeSubtle: typeof crypto.subtle,
        nativeUuid: typeof crypto.randomUUID,
        uuid: createUuid(),
        checksum,
        uploadStatus: uploads.tasks.value[0]?.status,
        uploadedDigest,
        visitorId,
        restoredVisitorId: restored.visitor.value.visitorId
      };
      uploads.dispose();
      share.dispose();
      restored.dispose();
      return result;
    });
    expect(result.secure).toBe(false);
    expect(result.nativeSubtle).toBe('undefined');
    expect(result.nativeUuid).toBe('undefined');
    expect(result.uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(result.checksum).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
    expect(result.uploadedDigest).toBe(result.checksum);
    expect(result.uploadStatus).toBe('COMPLETED');
    expect(result.visitorId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.restoredVisitorId).toBe(result.visitorId);
  } finally {
    await fixture.close();
  }
});
