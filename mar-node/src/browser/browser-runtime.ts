import type { BrowserContext, CDPSession } from 'playwright';
import {
  BROWSER_TAB_LIMIT,
  type BrowserDownloadRead,
  type BrowserNodeAttachmentCommand,
  type BrowserProfileTarget,
  type BrowserSettingsSnapshot
} from '@myagentroam/protocol';
import { BrowserAttachmentService } from './browser-attachment-service.js';
import {
  BrowserAgentAccess,
  type BrowserAgentAction,
  type BrowserAgentExecution
} from './browser-agent-access.js';
import type { BrowserAttachmentEncoder } from './browser-attachment.js';
import { BrowserCacheMaintenance } from './browser-cache-maintenance.js';
import { BrowserProfiles } from './browser-profiles.js';
import type { BrowserProfileData } from './browser-profile-data.js';
import { BrowserSessionService, type BrowserSessionKey } from './browser-session-service.js';
import { BrowserTabs } from './browser-tabs.js';

type RunningBrowser = {
  context: BrowserContext;
  data?: BrowserProfileData;
  directory?: string;
  downloads?: { session: CDPSession; directory: string };
  /** Resolves only when the process and its writable mounts are released. */
  close: () => Promise<void>;
};
type LiveBrowser = {
  tabs: BrowserTabs;
  access: BrowserAgentAccess;
  data?: BrowserProfileData;
  persistent: boolean;
};

/** Composition of Node Browser owners, installed only with a deployment's
 * verified execution boundary. The boundary launches an isolated context with
 * an initial page and a separately trusted codec. The runtime closes data
 * attachments before their borrowed browsing resource; it owns no transport,
 * user authentication, network rules or Playwright command state. */
export class BrowserRuntime {
  readonly attachments: BrowserAttachmentService;
  private readonly profiles: BrowserProfiles;
  private readonly sessions: BrowserSessionService<BrowserWithCache>;
  private readonly retention: ReturnType<typeof setInterval>;
  private profileSweep: Promise<void> | undefined;
  private readonly maintenance = new Map<string, Promise<void>>();
  private stopped = false;
  private stopping: Promise<void> | undefined;

  constructor(
    private readonly options: {
      maxBrowsers: number;
      profileRoot: string;
      profileUnused: (path: string) => Promise<boolean>;
      workspacePath?: (workspaceId: string) => string | undefined;
      workspaceFilesChanged?: (workspaceId: string) => void;
      launch: (profilePath?: string) => Promise<RunningBrowser>;
      encoder: (hd: boolean) => Promise<BrowserAttachmentEncoder>;
      failed: (error: unknown) => void;
    }
  ) {
    this.profiles = new BrowserProfiles({
      root: options.profileRoot,
      isUnused: options.profileUnused,
      failed: options.failed
    });
    this.sessions = new BrowserSessionService<BrowserWithCache>({
      limit: options.maxBrowsers,
      onCloseFailed: () => options.failed(new Error('BROWSER_CLOSE_FAILED')),
      launch: async (scope, id, preserveLogin) => {
        const profile = preserveLogin ? await this.profiles.acquire(scope) : undefined;
        let browser: RunningBrowser;
        try {
          browser = await options.launch(profile?.path);
        } catch (error) {
          // The boundary may reject launch only after disposing partial resources.
          await profile?.release();
          throw error;
        }
        const data = browser.data;
        const cache =
          data &&
          new BrowserCacheMaintenance({
            lastCleanupAt: profile?.lastCacheCleanupAt,
            record: profile?.recordCacheCleanup,
            clear: () => data.clear({ range: 'all', categories: ['cache'] }),
            failed: options.failed
          });
        const tabs = new BrowserTabs(browser.context, {
          limit: BROWSER_TAB_LIMIT,
          failed: options.failed,
          directory: browser.directory,
          downloads: browser.downloads,
          onDownloadBytesReceived: () => this.sessions.touch(scope, id),
          favicon: browser.data?.favicon.bind(browser.data),
          workspacePath: () => options.workspacePath?.(scope.workspaceId),
          workspaceFilesChanged: () => options.workspaceFilesChanged?.(scope.workspaceId)
        });
        const access = new BrowserAgentAccess(
          () => browser.context.browser(),
          () => {
            if (!this.sessions.touch(scope, id)) return false;
            tabs.markAgentActivity();
            return true;
          },
          options.failed
        );
        browser.context.once('close', () => {
          void this.close(scope, id).catch(options.failed);
        });
        return {
          resource: {
            tabs,
            access,
            persistent: preserveLogin,
            ...(cache && { cache }),
            ...(browser.data ? { data: browser.data } : {})
          },
          agentConnected: () => access.hasClients(),
          close: async () => {
            await access.close();
            await this.attachments.revokeBrowser(id);
            await cache?.close();
            await browser.close();
            await profile?.release();
          }
        };
      }
    });
    this.attachments = new BrowserAttachmentService({
      sessions: {
        lookup: (scope) => this.sessions.lookup(scope),
        pin: (scope, id) => {
          const { resource, release, activity } = this.sessions.pin(scope, id);
          return { resource: resource.tabs, release, activity };
        }
      },
      encoder: options.encoder,
      failed: options.failed
    });
    this.sweep();
    this.retention = setInterval(() => this.sweep(), 24 * 60 * 60_000);
    this.retention.unref();
  }

  open(scope: BrowserSessionKey, preserveLogin = false): Promise<string> {
    if (this.stopped) return Promise.reject(new Error('BROWSER_STOPPED'));
    return this.sessions.open(scope, preserveLogin);
  }

  lookup(scope: BrowserSessionKey): string | undefined {
    return this.stopped ? undefined : this.sessions.lookup(scope);
  }

  syncSettings(scope: BrowserSessionKey, id: string, settings?: BrowserSettingsSnapshot) {
    return this.sessions.use(scope, id, async ({ cache }) => {
      if (!cache && settings) throw new Error('BROWSER_SETTINGS_SYNC_UNAVAILABLE');
      return cache?.sync(settings);
    });
  }

  async revokeAttachment(
    userId: number,
    {
      attachmentId,
      code,
      workspaceId,
      browserId
    }: Extract<BrowserNodeAttachmentCommand, { action: 'revoke' }>
  ): Promise<void> {
    const detach = this.attachments.revoke(attachmentId, code);
    const scope = { userId, workspaceId };
    // Explicit scope loss affects native downloads even if the writer is gone.
    if (code === 'BROWSER_NOT_AUTHORIZED' && this.lookup(scope) === browserId) {
      await Promise.all([
        detach,
        this.sessions.use(scope, browserId, ({ tabs }) => tabs.cancelDownloads())
      ]);
    } else await detach;
  }

  readDownload(
    userId: number,
    { workspaceId, browserId, command }: BrowserDownloadRead
  ): Promise<unknown> {
    if (this.stopped) return Promise.reject(new Error('BROWSER_STOPPED'));
    return this.sessions.use({ userId, workspaceId }, browserId, ({ tabs }) =>
      tabs.download(command)
    );
  }

  async agentAction(
    scope: BrowserSessionKey,
    command: BrowserAgentAction,
    execution: BrowserAgentExecution,
    signal: AbortSignal
  ) {
    signal.throwIfAborted();
    const id = command.action === 'describe' ? await this.open(scope, true) : this.lookup(scope);
    if (!id) throw new Error('BROWSER_SESSION_ENDED');
    return this.sessions.use(scope, id, async ({ tabs, access }) => {
      signal.throwIfAborted();
      if (command.action === 'select') {
        tabs.select(command.tabId);
        if (!this.sessions.touch(scope, id)) throw new Error('BROWSER_SESSION_ENDED');
        tabs.markAgentActivity();
        return tabs.agentTabs();
      }
      const resource = await access.describe(execution);
      signal.throwIfAborted();
      return { browserId: id, ...tabs.agentTabs(), ...resource };
    });
  }

  async describeProfile(scope: BrowserSessionKey): Promise<BrowserProfileTarget | undefined> {
    if (this.stopped) throw new Error('BROWSER_STOPPED');
    const id = this.sessions.lookup(scope);
    if (id)
      return this.sessions.use(scope, id, async ({ data, persistent }) =>
        data ? { id, kind: 'live', persistent } : undefined
      );
    const stored = await this.profiles.inspect(scope);
    if (stored) return { id: stored, kind: 'stored', persistent: true };
  }

  useProfile<T>(
    scope: BrowserSessionKey,
    target: BrowserProfileTarget,
    run: (data: BrowserProfileData) => Promise<T>
  ): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('BROWSER_STOPPED'));
    if (target.kind === 'live') {
      return this.sessions.use(scope, target.id, ({ data, persistent }) => {
        if (target.persistent !== persistent) throw new Error('BROWSER_PROFILE_CHANGED');
        if (!data) throw new Error('BROWSER_DATA_UNAVAILABLE');
        return run(data);
      });
    }
    const key = JSON.stringify([scope.workspaceId, scope.userId]);
    const result = (this.maintenance.get(key) ?? Promise.resolve()).then(async () => {
      if (this.stopped) throw new Error('BROWSER_STOPPED');
      if (!target.persistent || this.sessions.lookup(scope))
        throw new Error('BROWSER_PROFILE_CHANGED');
      const profile = await this.profiles.maintain(scope, target.id);
      let browser: RunningBrowser;
      try {
        browser = await this.options.launch(profile.path);
      } catch (error) {
        await profile.release();
        throw error;
      }
      try {
        if (!browser.data) throw new Error('BROWSER_DATA_UNAVAILABLE');
        return await run(browser.data);
      } finally {
        await browser.close();
        await profile.release();
      }
    });
    const drain = result.then(
      () => undefined,
      () => undefined
    );
    this.maintenance.set(key, drain);
    void drain.then(() => {
      if (this.maintenance.get(key) === drain) this.maintenance.delete(key);
    });
    return result;
  }

  async close(scope: BrowserSessionKey, id: string): Promise<void> {
    await this.sessions.close(scope, id);
  }

  shutdown(): Promise<void> {
    this.stopped = true;
    clearInterval(this.retention);
    return (this.stopping ??= this.attachments.shutdown().finally(async () => {
      try {
        await this.sessions.shutdown();
      } finally {
        await Promise.all([this.profileSweep, ...this.maintenance.values()]);
      }
    }));
  }

  private sweep(): void {
    if (this.profileSweep) return;
    this.profileSweep = this.profiles
      .sweep()
      .catch(this.options.failed)
      .finally(() => {
        this.profileSweep = undefined;
      });
  }
}

type BrowserWithCache = LiveBrowser & { cache?: BrowserCacheMaintenance };
