import { createHash } from 'node:crypto';
import type { NodeConnector } from '../../src/connector.js';
import type { WorkspaceWorkbenchService } from '../../src/workspace/workspace-workbench-service.js';

export async function openComposerUploadFixture(
  connector: NodeConnector,
  input: {
    workspaceId: string;
    id: string;
    name: string;
    mime: string;
    bytes: Uint8Array;
  }
) {
  const { workspaceWorkbenchService } = connector as unknown as {
    workspaceWorkbenchService: WorkspaceWorkbenchService;
  };
  const target = await workspaceWorkbenchService.openFileUpload({
    direction: 'UPLOAD',
    resource: { kind: 'WORKSPACE_FILE', workspaceId: input.workspaceId, path: input.name },
    fileName: input.name,
    size: input.bytes.length,
    sha256: createHash('sha256').update(input.bytes).digest('hex'),
    composerAttachment: { id: input.id, mime: input.mime }
  });
  return async () => {
    await target.write(input.bytes);
    await target.complete(input.bytes.length, AbortSignal.timeout(10_000));
  };
}
