import { join } from 'node:path';
import { chromium } from 'playwright';
import { z } from 'zod';
import {
  browserNodeAttachmentCommandSchema,
  browserUploadSchema,
  browserUploadStreamSchema,
  browserDownloadRequestSchema,
  browserDownloadStreamSchema,
  type BrowserAttachmentRoute
} from '@myagentroam/protocol';
import { NodeStreamGrants } from '../connection/node-stream-grants.js';
import { parseBrowserStreamGrant } from '@myagentroam/protocol/browser-stream';
import type { NodeStreamHandler } from '@myagentroam/protocol/node-stream-mux';
import { serveBrowserStream } from './browser-stream-channel.js';
import { createBrowserLauncher } from './browser-launcher.js';
import { chromiumProfileLock } from './browser-profile-lock.js';
import {
  createBrowserProfileOperation,
  createBrowserResourceOperation
} from './browser-resource-operations.js';
import { BrowserRuntime } from './browser-runtime.js';
type Command = 'resource' | 'profile' | 'attachment' | 'upload' | 'download';
const nodeRequest = z.object({
  generation: z.string(),
  __requestUserId: z.number().int().positive().safe(),
  payload: z.record(z.string(), z.unknown())
});

/** Connector-facing Browser composition. Owns the runtime and stream admission; workspace admission, identity and ICE negotiation stay with the Connector. */
export class BrowserNodeService {
  private readonly browser: BrowserRuntime;
  private readonly launcher: ReturnType<typeof createBrowserLauncher>;
  private readonly resource;
  private readonly profile;
  private readonly fileGrants = new NodeStreamGrants();

  constructor(
    private readonly options: {
      root: string;
      generation: string;
      requireWorkspace: (id: string) => void;
      workspacePath: (id: string) => string | undefined;
      workspaceFilesChanged?: (id: string) => void;
      failed: (error: unknown) => void;
    }
  ) {
    const profileRoot = join(options.root, 'profiles');
    this.launcher = createBrowserLauncher(join(options.root, 'runs'), profileRoot, options.failed);
    this.browser = new BrowserRuntime({
      maxBrowsers: 16,
      profileRoot,
      profileUnused: async (path) => (await chromiumProfileLock(path)) !== 'live',
      workspacePath: options.workspacePath,
      ...(options.workspaceFilesChanged && {
        workspaceFilesChanged: options.workspaceFilesChanged
      }),
      launch: this.launcher.launch,
      failed: options.failed
    });
    this.resource = createBrowserResourceOperation(this.browser, options.requireWorkspace);
    this.profile = createBrowserProfileOperation(this.browser, options.requireWorkspace);
  }

  async probe(): Promise<boolean> {
    try {
      await this.launcher.sweepOrphans();
      const browser = await chromium.launch({
        channel: 'chromium',
        headless: true,
        timeout: 10_000
      });
      await browser.close();
      return true;
    } catch (error) {
      this.options.failed(error);
      return false;
    }
  }

  execute(operation: Command, value: unknown): Promise<unknown> {
    const result = nodeRequest.safeParse(value);
    if (!result.success) return Promise.reject(new Error('BROWSER_RESOURCE_INVALID'));
    const { generation, payload, __requestUserId } = result.data;
    const { transportId, ...filePayload } = payload;
    const binding = typeof transportId === 'string' ? transportId : undefined;
    if (generation !== this.options.generation)
      return Promise.reject(new Error('BROWSER_NODE_CHANGED'));
    if (operation === 'attachment') return this.attachment(payload, __requestUserId);
    if (operation === 'upload') {
      const stream = browserUploadStreamSchema.safeParse(filePayload);
      if (stream.success) {
        return Promise.resolve({
          grant: this.fileGrants.issue(
            'browser-file-upload',
            (file, signal) =>
              this.browser.attachments.uploadStream(__requestUserId, stream.data, file, signal),
            binding
          )
        });
      }
      const upload = browserUploadSchema.safeParse(payload);
      if (!upload.success) return Promise.reject(new Error('BROWSER_UPLOAD_INVALID'));
      return this.browser.attachments.upload(__requestUserId, upload.data);
    }
    if (operation === 'download') {
      const stream = browserDownloadStreamSchema.safeParse(filePayload);
      if (stream.success) {
        const input = stream.data;
        this.options.requireWorkspace(input.workspaceId);
        return Promise.resolve({
          grant: this.fileGrants.issue(
            'browser-file-download',
            (file, signal) => {
              this.options.requireWorkspace(input.workspaceId);
              return this.browser.streamDownload(__requestUserId, input, file, signal);
            },
            binding
          )
        });
      }
      const download = browserDownloadRequestSchema.safeParse(payload);
      if (!download.success) return Promise.reject(new Error('BROWSER_DOWNLOAD_INVALID'));
      return this.browser.attachments.download(__requestUserId, download.data);
    }
    return (operation === 'resource' ? this.resource : this.profile)({
      ...payload,
      __requestUserId
    });
  }

  consumeFileStream(
    kind: string,
    grant: string,
    direct?: { binding: string; signal: AbortSignal }
  ) {
    return this.fileGrants.consume(kind, grant, direct);
  }

  consumePictureStream(
    grant: string,
    route: BrowserAttachmentRoute
  ): NodeStreamHandler | undefined {
    const open = parseBrowserStreamGrant(grant);
    if (!open) return undefined;
    return (stream) => serveBrowserStream(this.browser.attachments, open, route, stream);
  }

  agentAction(
    scope: Parameters<BrowserRuntime['agentAction']>[0],
    command: Parameters<BrowserRuntime['agentAction']>[1],
    execution: Parameters<BrowserRuntime['agentAction']>[2],
    signal: AbortSignal
  ) {
    return this.browser.agentAction(scope, command, execution, signal);
  }

  async disconnect(): Promise<void> {
    this.fileGrants.clear();
    await this.browser.attachments.disconnect('BROWSER_CONTROL_DISCONNECTED');
  }

  async shutdown(): Promise<void> {
    await this.disconnect();
    await this.browser.shutdown();
  }

  private async attachment(payload: unknown, userId: number) {
    const result = browserNodeAttachmentCommandSchema.safeParse(payload);
    if (!result.success) throw new Error('BROWSER_RESOURCE_INVALID');
    const command = result.data;
    if (command.action === 'revoke-file-stream') return this.fileGrants.revoke(command.grant);
    if (command.action === 'renew')
      return this.browser.attachments.renew(command.attachmentId, command.expiresAt);
    if (command.action === 'revoke') return this.browser.revokeAttachment(userId, command);
    const { grant } = command;
    if (grant.userId !== userId) throw new Error('BROWSER_NOT_AUTHORIZED');
    this.options.requireWorkspace(grant.workspaceId);
    await this.browser.syncSettings(
      { userId, workspaceId: grant.workspaceId },
      grant.browserId,
      command.settings
    );
    this.browser.attachments.prepare(grant);
    return {};
  }
}
