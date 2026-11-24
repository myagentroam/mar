import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { WebSocket } from 'ws';
import { z } from 'zod';
import {
  BROWSER_CONTROL_MAX_BYTES,
  BROWSER_RELAY_READY,
  browserNodeAttachmentCommandSchema,
  browserUploadSchema,
  browserDownloadRequestSchema,
  browserDownloadReadSchema,
  type BrowserAttachmentRoute
} from '@myagentroam/protocol';
import { openBrowserIceChannel, openBrowserRelayChannel } from './browser-data-channel.js';
import { createBrowserLauncher } from './browser-launcher.js';
import { chromiumProfileLock } from './browser-profile-lock.js';
import {
  createBrowserProfileOperation,
  createBrowserResourceOperation
} from './browser-resource-operations.js';
import { BrowserRuntime } from './browser-runtime.js';
import { createBrowserVideoEncoder } from './browser-video-encoder.js';
import {
  BROWSER_VIDEO_BITRATE,
  BROWSER_VIDEO_FRAMERATE,
  BROWSER_VIDEO_HD_BITRATE,
  BROWSER_VIDEO_HD_LIMIT,
  BROWSER_VIEWPORT
} from './browser-video-config.js';

const encoderOrigin = 'https://mar-browser-encoder.invalid/';
type Command = 'resource' | 'profile' | 'attachment' | 'upload' | 'download';
const nodeRequest = z.object({
  generation: z.string(),
  __requestUserId: z.number().int().positive().safe(),
  payload: z.record(z.string(), z.unknown())
});

/** Connector-facing Browser composition. Owns the runtime and trusted encoder
 * host; workspace admission, identity and ICE negotiation stay with the Connector. */
export class BrowserNodeService {
  private readonly browser: BrowserRuntime;
  private readonly launcher: ReturnType<typeof createBrowserLauncher>;
  private readonly resource;
  private readonly profile;
  private encoderHost?: ReturnType<typeof chromium.launch>;
  private readonly relaySockets = new Set<WebSocket>();

  constructor(
    private readonly options: {
      root: string;
      generation: string;
      requireWorkspace: (id: string) => void;
      workspacePath: (id: string) => string | undefined;
      workspaceFilesChanged?: (id: string) => void;
      relay: () => { endpoint: string; nodeId: string; credential: string };
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
      encoder: (hd) => this.encoder(hd),
      failed: options.failed
    });
    this.resource = createBrowserResourceOperation(this.browser, options.requireWorkspace);
    this.profile = createBrowserProfileOperation(this.browser, options.requireWorkspace);
  }

  async probe(): Promise<boolean> {
    try {
      await this.launcher.sweepOrphans();
      await access(chromium.executablePath());
      const encoder = await this.encoder();
      try {
        const frame = await encoder.probeFrame();
        return frame.key && frame.data.length > 0;
      } finally {
        await encoder.close();
      }
    } catch (error) {
      this.options.failed(error);
      return false;
    }
  }

  execute(operation: Command, value: unknown): Promise<unknown> {
    const result = nodeRequest.safeParse(value);
    if (!result.success) return Promise.reject(new Error('BROWSER_RESOURCE_INVALID'));
    const { generation, payload, __requestUserId } = result.data;
    if (generation !== this.options.generation)
      return Promise.reject(new Error('BROWSER_NODE_CHANGED'));
    if (operation === 'attachment') return this.attachment(payload, __requestUserId);
    if (operation === 'upload') {
      const upload = browserUploadSchema.safeParse(payload);
      if (!upload.success) return Promise.reject(new Error('BROWSER_UPLOAD_INVALID'));
      return this.browser.attachments.upload(__requestUserId, upload.data);
    }
    if (operation === 'download') {
      const read = browserDownloadReadSchema.safeParse(payload);
      if (read.success) {
        this.options.requireWorkspace(read.data.workspaceId);
        return this.browser.readDownload(__requestUserId, read.data);
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

  openIce(
    route: Extract<BrowserAttachmentRoute, { type: 'ice' }>,
    channel: RTCDataChannel,
    first: unknown
  ): void {
    openBrowserIceChannel(this.browser.attachments, route, channel, first, this.options.failed);
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
    for (const socket of this.relaySockets) socket.terminate();
    await this.browser.attachments.disconnect('BROWSER_CONTROL_DISCONNECTED');
  }

  async shutdown(): Promise<void> {
    try {
      await this.disconnect();
      await this.browser.shutdown();
    } finally {
      if (this.encoderHost) await (await this.encoderHost).close();
    }
  }

  private async attachment(payload: unknown, userId: number) {
    const result = browserNodeAttachmentCommandSchema.safeParse(payload);
    if (!result.success) throw new Error('BROWSER_RESOURCE_INVALID');
    const command = result.data;
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
    if (grant.route.type === 'relay') {
      try {
        await this.connectRelay(grant.attachmentId, grant.expiresAt);
      } catch (error) {
        await this.browser.attachments.revoke(grant.attachmentId, 'BROWSER_RELAY_UNAVAILABLE');
        throw error;
      }
    }
    return {};
  }

  private connectRelay(id: string, expiresAt: number): Promise<void> {
    const { endpoint, nodeId, credential } = this.options.relay();
    const socket = new WebSocket(endpoint, {
      maxPayload: BROWSER_CONTROL_MAX_BYTES,
      perMessageDeflate: false,
      headers: {
        Authorization: `Bearer ${credential}`,
        'X-Mar-Node': nodeId,
        'X-Mar-Node-Generation': this.options.generation,
        'X-Mar-Browser-Attachment': id
      }
    });
    this.relaySockets.add(socket);
    socket.once('close', () => this.relaySockets.delete(socket));
    return new Promise<void>((resolve, reject) => {
      const fail = () => {
        clearTimeout(deadline);
        socket.terminate();
        reject(new Error('BROWSER_RELAY_UNAVAILABLE'));
      };
      const deadline = setTimeout(fail, Math.max(1, expiresAt - Date.now()));
      socket.on('error', fail);
      socket.once('close', fail);
      socket.once('message', (data, binary) => {
        if (binary || data.toString() !== BROWSER_RELAY_READY) return fail();
        clearTimeout(deadline);
        socket.off('close', fail);
        socket.off('error', fail);
        openBrowserRelayChannel(this.browser.attachments, id, socket, this.options.failed);
        resolve();
      });
    });
  }

  private async encoder(hd = false) {
    if (!this.encoderHost) {
      const launch = chromium.launch({
        channel: 'chromium',
        headless: true,
        chromiumSandbox: false,
        timeout: 10_000
      });
      const reset = () => {
        if (this.encoderHost === launch) delete this.encoderHost;
      };
      this.encoderHost = launch;
      void launch.then((host) => {
        host.once('disconnected', reset);
        if (!host.isConnected()) reset();
      }, reset);
    }
    const host = await this.encoderHost;
    const page = await host.newPage();
    try {
      await page.route(encoderOrigin, (route) =>
        route.fulfill({ contentType: 'text/html', body: '<!doctype html>' })
      );
      await page.goto(encoderOrigin);
      const create = (hd: boolean) =>
        createBrowserVideoEncoder(page, {
          ...(hd ? BROWSER_VIDEO_HD_LIMIT : BROWSER_VIEWPORT),
          bitrate: hd ? BROWSER_VIDEO_HD_BITRATE : BROWSER_VIDEO_BITRATE,
          framerate: BROWSER_VIDEO_FRAMERATE,
          hd
        });
      const probe = async (codec: Awaited<ReturnType<typeof create>>) => {
        const jpeg = await page.screenshot({
          type: 'jpeg',
          clip: { x: 0, y: 0, width: 16, height: 16 },
          timeout: 5_000
        });
        return codec.encode(jpeg, true);
      };
      let codec: Awaited<ReturnType<typeof create>> | undefined;
      if (hd) {
        try {
          codec = await create(true);
          const frame = await probe(codec);
          if (!frame.key || !frame.data.length) throw new Error('BROWSER_H264_ENCODER_UNAVAILABLE');
        } catch {
          await codec?.close();
          codec = undefined;
        }
      }
      const negotiatedHd = codec !== undefined;
      const active = codec ?? (await create(false));
      return {
        ...(negotiatedHd && { hd: true as const }),
        encode: active.encode,
        probeFrame: () => probe(active),
        close: async () => {
          try {
            await active.close();
          } finally {
            await page.close();
          }
        }
      };
    } catch {
      await page.close();
      throw new Error('BROWSER_H264_ENCODER_UNAVAILABLE');
    }
  }
}
