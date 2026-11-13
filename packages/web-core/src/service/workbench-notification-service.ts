import {
  notificationCreatedSchema,
  notificationTargetReadSchema,
  serverNotificationSchema,
  type ServerNotification,
  type NotificationTarget
} from '@myagentroam/protocol';
import { computed, ref, watch, type Ref, type WatchStopHandle } from 'vue';
import type { WorkbenchLiveEvent } from '../service/workbench-live-service.js';
import type { WorkspaceUploadTask } from '../service/workspace-upload-service.js';
import { errorCode } from '../util/api-error.js';
import {
  activeRecentRunStatus,
  recentRunTimeReference
} from '../util/notification-presentation.js';
import { translate } from './locale-preference-service.js';
import {
  createWorkbenchSystemNotificationService,
  isWorkbenchForeground
} from './workbench-system-notification-service.js';

export type { NotificationTarget } from '@myagentroam/protocol';

interface LocalNotificationRecord {
  readonly id: string;
  readonly title: string;
  readonly message: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly expiresAt: number;
  readonly read: boolean;
  readonly source: 'local';
}
export type LocalNotification = LocalNotificationRecord &
  (
    | {
        readonly kind: 'upload';
        readonly target?: LocalWorkspaceNotificationTarget;
        readonly action?: never;
      }
    | { readonly kind: 'web-update'; readonly action?: 'RELOAD_PAGE'; readonly target?: never }
  );
export type WorkbenchNotification =
  (ServerNotification & { readonly source: 'server'; readonly action?: never }) | LocalNotification;
export type WorkbenchNotificationKind = WorkbenchNotification['kind'];

export interface LocalWorkspaceNotificationTarget {
  readonly targetType?: undefined;
  readonly nodeId: string;
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly sessionName?: string;
}

export type WorkbenchNotificationTarget = NotificationTarget | LocalWorkspaceNotificationTarget;

type ActiveNotificationTarget =
  | Pick<
      Extract<NotificationTarget, { targetType: 'WORKSPACE_SESSION' }>,
      'targetType' | 'nodeId' | 'workspaceId' | 'sessionId'
    >
  | Pick<
      Extract<NotificationTarget, { targetType: 'HOSTED_CONVERSATION' }>,
      'targetType' | 'nodeId' | 'conversationId'
    >;

export interface RecentRun {
  readonly sessionGroup?: import('@myagentroam/protocol').SessionGroup;
  readonly nodeId: string;
  readonly runId: string;
  readonly workspaceId: string;
  readonly workspaceName?: string;
  readonly sessionId: string;
  readonly sessionTitle: string;
  readonly userMessage?: string;
  readonly runner: string;
  readonly status:
    'STARTING' | 'RUNNING' | 'CANCELLING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'INTERRUPTED';
  readonly interruptionReason?: 'USER_STOP';
  readonly createdAt: number;
  readonly startedAt: number;
  readonly completedAt: number | null;
  readonly sortAt: number;
  readonly updatedAt: number;
  readonly version: number;
}

export type WorkbenchNotificationInput = (
  | Omit<
      Extract<LocalNotification, { kind: 'upload' }>,
      'createdAt' | 'updatedAt' | 'expiresAt' | 'read' | 'source'
    >
  | Omit<
      Extract<LocalNotification, { kind: 'web-update' }>,
      'createdAt' | 'updatedAt' | 'expiresAt' | 'read' | 'source'
    >
) & {
  readonly source?: 'local';
  readonly createdAt?: number;
  readonly expiresAt?: number;
  readonly read?: boolean;
};

export interface WorkbenchNotificationService {
  readonly notifications: Ref<WorkbenchNotification[]>;
  readonly unreadCount: Readonly<Ref<number>>;
  readonly previewNotificationId: Readonly<Ref<string | undefined>>;
  readonly notificationRevision: Readonly<Ref<number>>;
  readonly systemNotifications: ReturnType<typeof createWorkbenchSystemNotificationService>;
  readonly recentRuns: Readonly<Ref<RecentRun[]>>;
  hasActiveWorkspaceRun(nodeId: string, workspaceId: string): boolean;
  hasUnreadWorkspace(nodeId: string, workspaceId: string): boolean;
  workspaceTabSession(nodeId: string, workspaceId: string): string | undefined;
  hasUnreadSession(nodeId: string, workspaceId: string, sessionId: string): boolean;
  hasUnreadConversation(nodeId: string, conversationId: string): boolean;
  notify(input: WorkbenchNotificationInput): void;
  recordUpload(task: WorkspaceUploadTask): void;
  project(event: WorkbenchLiveEvent): boolean;
  projectServerMessage(message: unknown): boolean;
  load(): Promise<void>;
  /** Optional snapshot readiness preserves the captured targets; false cancels their read. */
  recover(targetsReady?: Promise<boolean | void>): Promise<void>;
  openNotification(notification: WorkbenchNotification | string): Promise<void>;
  openPendingSystemNotification(): Promise<boolean>;
  markAllRead(): void;
  markRead(id: string): void;
  markSessionRead(nodeId: string, workspaceId: string, sessionId: string): Promise<void>;
  markVisibleRead(): Promise<void>;
  markConversationRead(nodeId: string, conversationId: string): void;
  clearWebUpdate(): void;
  remove(id: string): void;
  start(): Promise<void>;
  dispose(): void;
}

export type WorkbenchNotificationView = Pick<
  WorkbenchNotificationService,
  | 'notifications'
  | 'unreadCount'
  | 'previewNotificationId'
  | 'notificationRevision'
  | 'recentRuns'
  | 'hasUnreadSession'
  | 'load'
  | 'markAllRead'
  | 'remove'
>;

const TTL_MS = 24 * 60 * 60_000;
const SWEEP_MS = 5 * 60_000;

export function sweepExpiredNotificationIds(ids: Map<string, number>, now = Date.now()): void {
  for (const [id, expiresAt] of ids) {
    if (expiresAt <= now) ids.delete(id);
  }
}

function hasUnexpiredNotificationId(
  ids: Map<string, number>,
  id: string,
  now = Date.now()
): boolean {
  const expiresAt = ids.get(id);
  if (expiresAt === undefined) return false;
  if (expiresAt <= now) {
    ids.delete(id);
    return false;
  }
  return true;
}

export function createWorkbenchNotificationService(
  username: Ref<string | undefined>,
  options: {
    readonly request?: <T>(path: string, init?: RequestInit) => Promise<T>;
    readonly activeTargets?: () => readonly ActiveNotificationTarget[];
    readonly onWorkspaceRunCompleted?: (nodeId: string, workspaceId: string) => void;
    readonly onNotificationClick?: (notification: WorkbenchNotification) => Promise<void>;
  } = {}
): WorkbenchNotificationService {
  const notifications = ref<WorkbenchNotification[]>([]);
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  let loadGeneration = 0;
  let refreshRequested = false;
  let refreshPromise: Promise<void> | undefined;
  let recoveryPromise: Promise<void> | undefined;
  let pendingRecovery:
    | {
        readonly targets: readonly ActiveNotificationTarget[];
        readonly account: string | undefined;
        readonly targetsReady: Promise<boolean | void> | undefined;
      }
    | undefined;
  const pendingCreatedNotificationIds = new Map<string, number>();
  const handledCreatedNotificationIds = new Map<string, number>();
  const notificationRevision = ref(0);
  const previewNotificationId = ref<string>();
  const pendingScenes = new Map<string, boolean>();
  const pendingTargetReads = new Map<
    string,
    { promise: Promise<void>; retry: { isCurrent: (() => boolean) | undefined } }
  >();
  let snapshotReadProjections: Array<(notification: ServerNotification) => boolean> | undefined;

  function preview(id: string): void {
    previewNotificationId.value = id;
    notificationRevision.value += 1;
  }
  const recentRuns = ref<RecentRun[]>([]);
  const unreadCount = computed(
    () =>
      notifications.value.filter(
        (notification) => !notification.read && notification.expiresAt > Date.now()
      ).length
  );
  const unreadSessionExpirations = computed(() => {
    const expirations = new Map<string, number>();
    for (const notification of notifications.value) {
      if (
        notification.read ||
        notification.source !== 'server' ||
        notification.target?.targetType !== 'WORKSPACE_SESSION'
      )
        continue;
      const { nodeId, workspaceId, sessionId } = notification.target;
      const key = JSON.stringify([nodeId, workspaceId, sessionId]);
      const previous = expirations.get(key);
      if (previous === undefined || notification.expiresAt > previous)
        expirations.set(key, notification.expiresAt);
    }
    return expirations;
  });
  const applicationBadge = createApplicationBadgeSynchronization(unreadCount);
  let openingNotificationCount = 0;
  let notificationClickGeneration = 0;
  const systemNotifications = createWorkbenchSystemNotificationService(
    username,
    openNotification,
    options.request
  );

  function storageKey(): string | undefined {
    return username.value === undefined
      ? undefined
      : `mar.workbench.notifications.v1.${username.value}`;
  }

  function persist(): void {
    const key = storageKey();
    if (key === undefined) return;
    try {
      localStorage.setItem(
        key,
        JSON.stringify(
          notifications.value.filter(
            (notification) =>
              notification.source !== 'server' &&
              (notification.kind === 'upload' || notification.kind === 'web-update')
          )
        )
      );
    } catch {
      // Unavailable local storage does not affect notifications on the current page.
    }
  }

  function removeExpired(now = Date.now()): void {
    sweepExpiredNotificationIds(pendingCreatedNotificationIds, now);
    sweepExpiredNotificationIds(handledCreatedNotificationIds, now);
    for (const id of pendingScenes.keys()) {
      if (!pendingCreatedNotificationIds.has(id)) pendingScenes.delete(id);
    }
    const next = notifications.value.filter((notification) => notification.expiresAt > now);
    if (next.length !== notifications.value.length) {
      notifications.value = next;
      persist();
    }
  }

  function restore(): void {
    const key = storageKey();
    notifications.value = [];
    if (key === undefined) return;
    try {
      const value = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown;
      if (!Array.isArray(value)) return;
      notifications.value = parseStoredWorkbenchNotifications(value)
        .filter(
          (notification) => notification.kind === 'upload' || notification.kind === 'web-update'
        )
        .map((notification) => ({
          ...notification,
          source: 'local' as const,
          read: notification.kind === 'upload' ? true : notification.read
        }));
      persist();
    } catch {
      localStorage.removeItem(key);
    }
  }

  function notify(input: WorkbenchNotificationInput): void {
    const now = Date.now();
    removeExpired(now);
    if (input.expiresAt !== undefined && input.expiresAt <= now) return;
    const existing = notifications.value.find((notification) => notification.id === input.id);
    const notification: WorkbenchNotification = {
      ...input,
      source: 'local',
      createdAt: existing?.createdAt ?? input.createdAt ?? now,
      updatedAt: now,
      expiresAt: input.expiresAt ?? existing?.expiresAt ?? now + TTL_MS,
      read: input.kind === 'upload' ? true : (existing?.read ?? input.read ?? false)
    };
    notifications.value = [
      notification,
      ...notifications.value.filter(
        (item) =>
          item.id !== input.id && (input.kind !== 'web-update' || item.kind !== 'web-update')
      )
    ];
    persist();
    if (
      existing === undefined &&
      isWorkbenchForeground() &&
      (input.kind === 'upload' || !notification.read)
    )
      preview(notification.id);
  }

  function recordUpload(task: WorkspaceUploadTask): void {
    if (task.status === 'CANCELLED') {
      remove(`upload:${task.id}`);
      return;
    }
    const terminal = task.status === 'COMPLETED' || task.status === 'FAILED';
    notify({
      id: `upload:${task.id}`,
      kind: 'upload',
      source: 'local',
      title:
        task.status === 'FAILED'
          ? translate('generated.workbenchNotificationService.fileUploadFailed')
          : task.status === 'COMPLETED'
            ? translate('generated.workbenchNotificationService.fileUploadCompleted')
            : translate('generated.workbenchNotificationService.uploadingFile'),
      message: `${task.name}${task.error === undefined ? '' : ` · ${task.error}`}`,
      target: { nodeId: task.nodeId, workspaceId: task.workspaceId },
      ...(terminal ? {} : { expiresAt: Date.now() + TTL_MS })
    });
  }

  function project(event: WorkbenchLiveEvent): boolean {
    void event;
    return false;
  }

  function applyServerSnapshot(
    result: { notifications: unknown[]; recentRuns?: unknown[] },
    confirmedReads: ReadonlyArray<(notification: ServerNotification) => boolean>
  ): void {
    const local = notifications.value.filter((notification) => notification.source !== 'server');
    notifications.value = [
      ...result.notifications.flatMap((value) => {
        const parsed = serverNotificationSchema.safeParse(value);
        if (!parsed.success) return [];
        return [
          {
            ...parsed.data,
            read: parsed.data.read || confirmedReads.some((matches) => matches(parsed.data)),
            source: 'server' as const
          }
        ];
      }),
      ...local
    ].sort((left, right) => right.createdAt - left.createdAt);
    recentRuns.value = (result.recentRuns ?? []).filter(isRecentRun).sort(compareRecentRuns);
  }

  function confirmPendingCreatedNotifications(): void {
    if (pendingCreatedNotificationIds.size === 0) return;
    const now = Date.now();

    for (const [id, expiresAt] of pendingCreatedNotificationIds) {
      pendingCreatedNotificationIds.delete(id);
      const foreground = pendingScenes.get(id);
      pendingScenes.delete(id);
      if (expiresAt <= now) {
        handledCreatedNotificationIds.delete(id);
        continue;
      }
      const notification = notifications.value.find(
        (item) => item.source === 'server' && item.id === id
      );
      if (notification !== undefined && notification.expiresAt <= now) {
        handledCreatedNotificationIds.delete(id);
        continue;
      }
      if (notification?.source === 'server' && !notification.read) {
        if (foreground === true && isWorkbenchForeground() && !isActiveTarget(notification.target))
          preview(id);
        if (foreground === false && !isWorkbenchForeground())
          void systemNotifications.show(notification, () =>
            notifications.value.some(
              (item) =>
                item.source === 'server' &&
                item.id === notification.id &&
                !item.read &&
                item.expiresAt > Date.now()
            )
          );
      }
      handledCreatedNotificationIds.set(id, expiresAt);
    }
  }

  async function drainRefreshes(generation: number): Promise<void> {
    while (generation === loadGeneration && refreshRequested) {
      refreshRequested = false;
      const readProjections: Array<(notification: ServerNotification) => boolean> = [];
      snapshotReadProjections = readProjections;
      let result: {
        notifications: unknown[];
        recentRuns?: unknown[];
      };
      try {
        result = await options.request!<{
          notifications: unknown[];
          recentRuns?: unknown[];
        }>('/api/notifications');
      } catch (error) {
        if (generation !== loadGeneration) return;
        if (refreshRequested) continue;
        throw error;
      } finally {
        if (snapshotReadProjections === readProjections) snapshotReadProjections = undefined;
      }
      if (generation !== loadGeneration) return;
      applyServerSnapshot(result, readProjections);
      applicationBadge.reconcile();
      if (!refreshRequested) confirmPendingCreatedNotifications();
    }
  }

  async function load(): Promise<void> {
    if (options.request === undefined) return;
    refreshRequested = true;
    if (refreshPromise === undefined) {
      const generation = loadGeneration;
      const operation = drainRefreshes(generation);
      const tracked = operation.finally(() => {
        if (refreshPromise !== tracked) return;
        refreshPromise = undefined;
        if (generation === loadGeneration && refreshRequested) refreshQuietly();
      });
      refreshPromise = tracked;
    }
    return refreshPromise;
  }

  function refreshQuietly(): void {
    void load().catch(() => undefined);
  }

  function handleFocus(): void {
    if (username.value !== undefined && isWorkbenchForeground())
      void recover().catch(() => undefined);
  }

  async function openNotification(input: WorkbenchNotification | string): Promise<void> {
    const account = username.value;
    const generation = loadGeneration;
    const clickGeneration = ++notificationClickGeneration;
    const id = typeof input === 'string' ? input : input.id;
    openingNotificationCount += 1;
    try {
      if (typeof input === 'string' || input.source === 'server') await load();
      if (
        generation !== loadGeneration ||
        clickGeneration !== notificationClickGeneration ||
        account !== username.value
      )
        return;
      const notification = notifications.value.find(
        (item) =>
          item.id === id &&
          item.expiresAt > Date.now() &&
          (typeof input !== 'string' || item.source === 'server')
      );
      if (notification === undefined) return;
      markRead(notification.id);
      await options.onNotificationClick?.(notification);
    } finally {
      if (generation === loadGeneration) openingNotificationCount -= 1;
    }
  }

  function recover(targetsReady?: Promise<boolean | void>): Promise<void> {
    if (openingNotificationCount > 0 || systemNotifications.hasPending()) return load();
    const targets = isWorkbenchForeground() ? (options.activeTargets?.() ?? []) : [];
    const account = username.value;
    const previous = pendingRecovery?.account === account ? pendingRecovery : undefined;
    const inherited =
      previous?.account === account && previous?.targetsReady !== undefined ? previous.targets : [];
    pendingRecovery = {
      // A focus recovery during refresh must not erase an already captured visible target.
      targets: [
        ...new Map(
          [...inherited, ...targets].map((target) => [JSON.stringify(target), { ...target }])
        ).values()
      ],
      account,
      targetsReady:
        previous?.targetsReady === undefined
          ? targetsReady
          : targetsReady === undefined
            ? previous.targetsReady
            : Promise.all([previous.targetsReady, targetsReady]).then((results) =>
                results.every((completed) => completed !== false)
              )
    };
    if (recoveryPromise !== undefined) return recoveryPromise;
    const generation = loadGeneration;
    const operation = (async () => {
      while (generation === loadGeneration && pendingRecovery !== undefined) {
        const { targets: active, account, targetsReady: ready } = pendingRecovery;
        pendingRecovery = undefined;
        try {
          const [, completed] = await Promise.all([load(), ready]);
          if (completed === false) continue;
        } catch (error) {
          if (generation !== loadGeneration) return;
          if (pendingRecovery !== undefined) continue;
          throw error;
        }
        await readVisibleTargets(active, account, generation);
      }
    })();
    const tracked = operation.finally(() => {
      if (recoveryPromise === tracked) recoveryPromise = undefined;
    });
    recoveryPromise = tracked;
    return tracked;
  }

  function requestAndRefresh(
    path: string,
    init: RequestInit,
    retryOnFailure = false,
    isCurrent: () => boolean = () => true
  ): Promise<void> {
    if (options.request === undefined) return Promise.resolve();
    const generation = loadGeneration;
    return options
      .request(path, init)
      .catch(async (error: unknown) => {
        if (
          retryOnFailure &&
          generation === loadGeneration &&
          isCurrent() &&
          errorCode(error) !== 'UNAUTHENTICATED' &&
          !(error instanceof Error && error.name === 'AbortError')
        )
          await options.request!(path, init).catch(() => undefined);
      })
      .then(() => {
        if (generation === loadGeneration) return load().catch(() => undefined);
      });
  }

  function projectServerMessage(value: unknown): boolean {
    const read = notificationTargetReadSchema.safeParse(value);
    if (read.success) {
      const message = read.data;
      const notificationIds = new Set(message.notificationIds);
      projectConfirmedRead((notification) => {
        const target = notification.target;
        if (!notificationIds.has(notification.id) || target.nodeId !== message.nodeId) return false;
        return message.type === 'notification.session-read'
          ? target.targetType === 'WORKSPACE_SESSION' &&
              target.workspaceId === message.workspaceId &&
              target.sessionId === message.sessionId
          : target.targetType === 'HOSTED_CONVERSATION' &&
              target.conversationId === message.conversationId;
      });
      return true;
    }
    if (isRecord(value) && typeof value.type === 'string' && value.type.startsWith('recent-run.')) {
      refreshQuietly();
      return true;
    }
    if (
      !isRecord(value) ||
      typeof value.type !== 'string' ||
      !value.type.startsWith('notification.')
    )
      return false;
    const parsed =
      value.type === 'notification.created'
        ? notificationCreatedSchema.safeParse(value)
        : undefined;
    if (parsed?.success) {
      const notification = parsed.data.notification;
      const now = Date.now();
      if (notification.expiresAt <= now) {
        refreshQuietly();
        return true;
      }
      if (
        hasUnexpiredNotificationId(handledCreatedNotificationIds, notification.id, now) ||
        hasUnexpiredNotificationId(pendingCreatedNotificationIds, notification.id, now)
      ) {
        refreshQuietly();
        return true;
      }
      if (notification.kind === 'run' && notification.target.targetType === 'WORKSPACE_SESSION')
        options.onWorkspaceRunCompleted?.(
          notification.target.nodeId,
          notification.target.workspaceId
        );
      const active = isWorkbenchForeground() && isActiveTarget(notification.target);
      if (active && !notification.read) {
        handledCreatedNotificationIds.set(notification.id, notification.expiresAt);
        requestAndRefresh(
          `/api/notifications/${encodeURIComponent(notification.id)}/read`,
          {
            method: 'POST',
            body: '{}'
          },
          true,
          () =>
            openingNotificationCount === 0 &&
            !systemNotifications.hasPending() &&
            isWorkbenchForeground() &&
            notification.expiresAt > Date.now() &&
            isActiveTarget(notification.target)
        );
        return true;
      }
      if (notification.read) {
        handledCreatedNotificationIds.set(notification.id, notification.expiresAt);
        refreshQuietly();
        return true;
      }
      pendingScenes.set(notification.id, isWorkbenchForeground());
      pendingCreatedNotificationIds.set(notification.id, notification.expiresAt);
      void load().catch(() => undefined);
      return true;
    }
    refreshQuietly();
    return true;
  }

  function isActiveTarget(target: WorkbenchNotificationTarget | ActiveNotificationTarget): boolean {
    if (target.targetType === undefined) return false;
    return (options.activeTargets?.() ?? []).some((active) => {
      if (target.targetType === 'HOSTED_CONVERSATION')
        return (
          active.targetType === 'HOSTED_CONVERSATION' &&
          active.nodeId === target.nodeId &&
          active.conversationId === target.conversationId
        );
      return (
        active.targetType === 'WORKSPACE_SESSION' &&
        active.nodeId === target.nodeId &&
        active.workspaceId === target.workspaceId &&
        active.sessionId === target.sessionId
      );
    });
  }

  function markAllRead(): void {
    const unread = notifications.value.filter((notification) => !notification.read);
    const localUnread = unread.filter((notification) => notification.source !== 'server');
    if (localUnread.length > 0) {
      const localIds = new Set(localUnread.map((notification) => notification.id));
      notifications.value = notifications.value.map((notification) =>
        localIds.has(notification.id) ? { ...notification, read: true } : notification
      );
      persist();
    }
    if (options.request !== undefined)
      requestAndRefresh('/api/notifications/read-all', { method: 'POST', body: '{}' });
  }

  function markRead(id: string): void {
    const notification = notifications.value.find((item) => item.id === id);
    if (notification === undefined || notification.read) return;
    if (notification.source === 'server') {
      requestAndRefresh(`/api/notifications/${encodeURIComponent(id)}/read`, {
        method: 'POST',
        body: '{}'
      });
      return;
    }
    notifications.value = notifications.value.map((item) =>
      item.id === id ? { ...item, read: true } : item
    );
    persist();
  }

  function hasActiveWorkspaceRun(nodeId: string, workspaceId: string): boolean {
    return recentRuns.value.some(
      (run) =>
        run.nodeId === nodeId &&
        run.workspaceId === workspaceId &&
        activeRecentRunStatus(run.status)
    );
  }

  function hasUnreadWorkspace(nodeId: string, workspaceId: string): boolean {
    return firstUnreadWorkspaceSession(nodeId, workspaceId) !== undefined;
  }

  function firstUnreadWorkspaceSession(nodeId: string, workspaceId: string): string | undefined {
    const now = Date.now();
    const entry = notifications.value.find(
      (notification) =>
        !notification.read &&
        notification.source === 'server' &&
        notification.expiresAt > now &&
        notification.target?.targetType === 'WORKSPACE_SESSION' &&
        notification.target.nodeId === nodeId &&
        notification.target.workspaceId === workspaceId
    );
    return entry?.target?.targetType === 'WORKSPACE_SESSION' ? entry.target.sessionId : undefined;
  }

  function hasUnreadSession(nodeId: string, workspaceId: string, sessionId: string): boolean {
    const expiresAt = unreadSessionExpirations.value.get(
      JSON.stringify([nodeId, workspaceId, sessionId])
    );
    // Check the clock on every lookup, including between notification sweeps.
    return expiresAt !== undefined && expiresAt > Date.now();
  }

  function markSessionRead(nodeId: string, workspaceId: string, sessionId: string): Promise<void> {
    return readTarget({ targetType: 'WORKSPACE_SESSION', nodeId, workspaceId, sessionId });
  }

  async function readVisibleTargets(
    targets: readonly ActiveNotificationTarget[],
    account: string | undefined,
    generation: number
  ): Promise<void> {
    await Promise.all(
      targets.map(async (target) => {
        const canRead = () =>
          generation === loadGeneration &&
          openingNotificationCount === 0 &&
          account === username.value &&
          isActiveTarget(target) &&
          isWorkbenchForeground();
        if (!canRead()) return;
        const unread =
          target.targetType === 'WORKSPACE_SESSION'
            ? hasUnreadSession(target.nodeId, target.workspaceId, target.sessionId)
            : hasUnreadConversation(target.nodeId, target.conversationId);
        if (unread) await readTarget(target, true, canRead);
      })
    );
  }

  function markVisibleRead(): Promise<void> {
    return readVisibleTargets(options.activeTargets?.() ?? [], username.value, loadGeneration);
  }

  function hasUnreadConversation(nodeId: string, conversationId: string): boolean {
    const now = Date.now();
    return notifications.value.some(
      (notification) =>
        !notification.read &&
        notification.source === 'server' &&
        notification.expiresAt > now &&
        notification.target?.targetType === 'HOSTED_CONVERSATION' &&
        notification.target.nodeId === nodeId &&
        notification.target.conversationId === conversationId
    );
  }

  function markConversationRead(nodeId: string, conversationId: string): void {
    void readTarget({ targetType: 'HOSTED_CONVERSATION', nodeId, conversationId });
  }

  function readTarget(
    target: ActiveNotificationTarget,
    retryOnFailure = false,
    isCurrent?: () => boolean
  ): Promise<void> {
    if (
      openingNotificationCount > 0 ||
      systemNotifications.hasPending() ||
      !isWorkbenchForeground()
    )
      return Promise.resolve();
    const { nodeId } = target;
    const workspace = target.targetType === 'WORKSPACE_SESSION';
    const unread = workspace
      ? hasUnreadSession(nodeId, target.workspaceId, target.sessionId)
      : hasUnreadConversation(nodeId, target.conversationId);
    if (!unread || options.request === undefined) return Promise.resolve();
    const body = workspace
      ? { nodeId, workspaceId: target.workspaceId, sessionId: target.sessionId }
      : { nodeId, conversationId: target.conversationId };
    const key = JSON.stringify([target.targetType, body]);
    const pending = pendingTargetReads.get(key);
    if (pending !== undefined) {
      if (retryOnFailure) pending.retry.isCurrent = isCurrent ?? (() => true);
      return pending.promise;
    }
    const retry = { isCurrent: retryOnFailure ? (isCurrent ?? (() => true)) : undefined };
    const covered = new Map(
      notifications.value.flatMap((notification) => {
        if (notification.source !== 'server' || notification.read) return [];
        const current = notification.target;
        const matches =
          current.nodeId === nodeId &&
          (workspace
            ? current.targetType === 'WORKSPACE_SESSION' &&
              current.workspaceId === target.workspaceId &&
              current.sessionId === target.sessionId
            : current.targetType === 'HOSTED_CONVERSATION' &&
              current.conversationId === target.conversationId);
        return matches ? [[notification.id, notification.updatedAt] as const] : [];
      })
    );
    const generation = loadGeneration;
    const operation = (async () => {
      const path = `/api/notifications/${workspace ? 'session' : 'conversation'}/read`;
      const init = { method: 'POST', body: JSON.stringify(body) };
      try {
        try {
          await options.request!(path, init);
        } catch (error) {
          if (
            generation !== loadGeneration ||
            retry.isCurrent?.() !== true ||
            errorCode(error) === 'UNAUTHENTICATED' ||
            (error instanceof Error && error.name === 'AbortError')
          )
            return;
          await options.request!(path, init);
        }
        if (generation === loadGeneration)
          projectConfirmedRead(
            (notification) => covered.get(notification.id) === notification.updatedAt
          );
      } catch {
        // Retain unread state; connection or focus recovery can retry the target.
      }
    })();
    const tracked = operation.finally(() => {
      if (pendingTargetReads.get(key)?.promise === tracked) pendingTargetReads.delete(key);
    });
    pendingTargetReads.set(key, { promise: tracked, retry });
    return tracked;
  }

  function projectConfirmedRead(matches: (notification: ServerNotification) => boolean): void {
    snapshotReadProjections?.push(matches);
    notifications.value = notifications.value.map((notification) =>
      notification.source === 'server' && !notification.read && matches(notification)
        ? { ...notification, read: true }
        : notification
    );
    applicationBadge.reconcile();
  }

  function remove(id: string): void {
    const notification = notifications.value.find((item) => item.id === id);
    if (notification?.source === 'server') {
      requestAndRefresh(`/api/notifications/${encodeURIComponent(id)}`, { method: 'DELETE' });
      return;
    }
    notifications.value = notifications.value.filter((item) => item.id !== id);
    persist();
  }

  function clearWebUpdate(): void {
    const next = notifications.value.filter((notification) => notification.kind !== 'web-update');
    if (next.length === notifications.value.length) return;
    notifications.value = next;
    persist();
  }

  async function start(): Promise<void> {
    const generation = loadGeneration;
    systemNotifications.start();
    applicationBadge.start();
    if (typeof window !== 'undefined') window.addEventListener('focus', handleFocus);
    restore();
    await load().catch(() => undefined);
    if (generation === loadGeneration && sweepTimer === undefined)
      sweepTimer = setInterval(removeExpired, SWEEP_MS);
  }

  function dispose(): void {
    if (typeof window !== 'undefined') window.removeEventListener('focus', handleFocus);
    systemNotifications.dispose();
    openingNotificationCount = 0;
    applicationBadge.dispose();
    loadGeneration += 1;
    refreshRequested = false;
    refreshPromise = undefined;
    recoveryPromise = undefined;
    pendingRecovery = undefined;
    pendingTargetReads.clear();
    snapshotReadProjections = undefined;
    pendingCreatedNotificationIds.clear();
    pendingScenes.clear();
    previewNotificationId.value = undefined;
    handledCreatedNotificationIds.clear();
    notifications.value = notifications.value.filter(
      (notification) => notification.source !== 'server'
    );
    recentRuns.value = [];
    if (sweepTimer !== undefined) clearInterval(sweepTimer);
    sweepTimer = undefined;
  }

  return {
    notifications,
    recentRuns,
    unreadCount,
    notificationRevision,
    previewNotificationId,
    systemNotifications,
    hasActiveWorkspaceRun,
    hasUnreadWorkspace,
    workspaceTabSession: firstUnreadWorkspaceSession,
    hasUnreadSession,
    hasUnreadConversation,
    notify,
    recordUpload,
    project,
    projectServerMessage,
    load,
    recover,
    openNotification,
    openPendingSystemNotification: systemNotifications.openPending,
    markAllRead,
    markRead,
    markSessionRead,
    markVisibleRead,
    markConversationRead,
    clearWebUpdate,
    remove,
    start,
    dispose
  };
}

function createApplicationBadgeSynchronization(unreadCount: Readonly<Ref<number>>) {
  let stop: WatchStopHandle | undefined;
  let pendingCount: number | undefined;
  let applying = false;

  async function applyPending(): Promise<void> {
    applying = true;
    while (pendingCount !== undefined) {
      const count = pendingCount;
      pendingCount = undefined;
      if (typeof navigator === 'undefined') continue;
      const badgeNavigator = navigator as Navigator & {
        readonly setAppBadge?: (contents?: number) => Promise<void>;
        readonly clearAppBadge?: () => Promise<void>;
      };
      try {
        if (count > 0) await badgeNavigator.setAppBadge?.(count);
        else if (badgeNavigator.clearAppBadge !== undefined) await badgeNavigator.clearAppBadge();
        else await badgeNavigator.setAppBadge?.(0);
      } catch {
        // A later count change, Server refresh, or focus will retry the latest badge.
      }
    }
    applying = false;
  }

  function sync(count: number): void {
    pendingCount = count;
    if (!applying) void applyPending();
  }

  function reconcile(): void {
    if (stop !== undefined) sync(unreadCount.value);
  }

  function start(): void {
    if (stop !== undefined) return;
    stop = watch(unreadCount, sync, { immediate: true });
    if (typeof window !== 'undefined') window.addEventListener('focus', reconcile);
  }

  function dispose(): void {
    if (typeof window !== 'undefined') window.removeEventListener('focus', reconcile);
    stop?.();
    stop = undefined;
    sync(0);
  }

  return { start, reconcile, dispose };
}

function compareRecentRuns(left: RecentRun, right: RecentRun): number {
  return (
    Number(activeRecentRunStatus(right.status)) - Number(activeRecentRunStatus(left.status)) ||
    recentRunTimeReference(right) - recentRunTimeReference(left) ||
    right.createdAt - left.createdAt ||
    right.runId.localeCompare(left.runId)
  );
}

function isRecentRun(value: unknown): value is RecentRun {
  if (!isRecord(value)) return false;
  return (
    typeof value.nodeId === 'string' &&
    typeof value.runId === 'string' &&
    typeof value.workspaceId === 'string' &&
    (value.workspaceName === undefined || typeof value.workspaceName === 'string') &&
    typeof value.sessionId === 'string' &&
    typeof value.sessionTitle === 'string' &&
    (value.sessionGroup === undefined ||
      value.sessionGroup === 'MAIN' ||
      value.sessionGroup === 'CHILD') &&
    (value.userMessage === undefined || typeof value.userMessage === 'string') &&
    typeof value.runner === 'string' &&
    [
      'STARTING',
      'RUNNING',
      'CANCELLING',
      'SUCCEEDED',
      'FAILED',
      'CANCELLED',
      'INTERRUPTED'
    ].includes(String(value.status)) &&
    (value.interruptionReason === undefined || value.interruptionReason === 'USER_STOP') &&
    typeof value.createdAt === 'number' &&
    typeof value.startedAt === 'number' &&
    (value.completedAt === null || typeof value.completedAt === 'number') &&
    typeof value.sortAt === 'number' &&
    typeof value.updatedAt === 'number' &&
    typeof value.version === 'number'
  );
}

export function parseStoredWorkbenchNotifications(
  value: unknown,
  now = Date.now()
): WorkbenchNotification[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isNotification)
    .filter((item) => item.expiresAt > now)
    .map((item) => ({ ...item, source: 'local' }));
}

function isNotification(value: unknown): value is LocalNotification {
  if (!isRecord(value)) return false;
  return (
    (value.kind === 'upload' || value.kind === 'web-update') &&
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.message === 'string' &&
    typeof value.createdAt === 'number' &&
    typeof value.updatedAt === 'number' &&
    typeof value.expiresAt === 'number' &&
    typeof value.read === 'boolean' &&
    (value.kind === 'upload'
      ? value.action === undefined &&
        (value.target === undefined || isNotificationTarget(value.target))
      : value.target === undefined &&
        (value.action === undefined || value.action === 'RELOAD_PAGE'))
  );
}

function isNotificationTarget(value: unknown): value is LocalWorkspaceNotificationTarget {
  if (!isRecord(value) || typeof value.nodeId !== 'string') return false;
  return (
    value.targetType === undefined &&
    value.conversationId === undefined &&
    (value.workspaceId === undefined || typeof value.workspaceId === 'string') &&
    (value.sessionId === undefined || typeof value.sessionId === 'string') &&
    (value.sessionName === undefined || typeof value.sessionName === 'string')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Owns the application-update subscription and its notification actions. */
export function createWorkbenchWebUpdateService(options: {
  readonly application: import('./pwa-application-service.js').PwaApplicationService | undefined;
  readonly notifications: Pick<
    ReturnType<typeof createWorkbenchNotificationService>,
    'notifications' | 'notify' | 'clearWebUpdate'
  >;
  readonly message: import('../model/message-feedback.js').MessageFeedback;
}) {
  const state = options.application?.state ?? ref({ offline: 'online' as const, checked: false });
  const checking = ref(false);
  let unsubscribe: (() => void) | undefined;
  function start(): void {
    if (unsubscribe !== undefined || options.application === undefined) return;
    unsubscribe = options.application.subscribe((value) => {
      if (!value.checked) return;
      const hasNotice = options.notifications.notifications.value.some(
        (item) => item.kind === 'web-update'
      );
      const update = value.update ?? (hasNotice ? value.reload : undefined);
      if (update === undefined) {
        if (value.reload === undefined) options.notifications.clearWebUpdate();
      } else {
        options.notifications.notify({
          id: `web-update:${update.version}:${update.buildId}`,
          kind: 'web-update',
          source: 'local',
          title: translate('webUpdate.title'),
          message: translate('webUpdate.message', { value0: update.version }),
          action: 'RELOAD_PAGE'
        });
      }
    });
  }
  function stop(): void {
    unsubscribe?.();
    unsubscribe = undefined;
  }
  async function check(): Promise<void> {
    if (checking.value || options.application === undefined) return;
    checking.value = true;
    try {
      await options.application.checkForUpdate();
      const current = options.application.state.value;
      options.message(
        translate(
          current.update
            ? 'webUpdate.available'
            : current.reload
              ? 'webUpdate.reloadAvailable'
              : 'webUpdate.upToDate'
        ),
        'info'
      );
    } catch (error) {
      options.message(translate('webUpdate.checkFailed'), 'error', error);
    } finally {
      checking.value = false;
    }
  }
  async function apply(): Promise<void> {
    if ((await options.application?.applyUpdate()) !== 'APPLIED')
      options.message(translate('webUpdate.unavailable'), 'warning');
  }
  return { state, checking, start, stop, check, apply };
}

export interface WorkbenchNotificationsView {
  notifications: Ref<WorkbenchNotification[], WorkbenchNotification[]>;
  unreadCount: Readonly<Ref<number, number>>;
  previewNotificationId: Readonly<Ref<string | undefined, string | undefined>>;
  notificationRevision: Readonly<Ref<number, number>>;
  recentRuns: Readonly<Ref<RecentRun[], RecentRun[]>>;
  load: () => Promise<void>;
  markAllRead: () => void;
  remove: (id: string) => void;
  systemNotifications: ReturnType<typeof createWorkbenchNotificationService>['systemNotifications'];
  hasActiveWorkspaceRun: (nodeId: string, workspaceId: string) => boolean;
  hasUnreadWorkspace: (nodeId: string, workspaceId: string) => boolean;
  hasUnreadSession: (nodeId: string, workspaceId: string, sessionId: string) => boolean;
  hasUnreadConversation: (nodeId: string, conversationId: string) => boolean;
}

export function createWorkbenchVisibleSessions(input: {
  readonly workspaceTarget: Readonly<
    Ref<import('../model/workbench.js').WorkspaceTarget | undefined>
  >;
  readonly selectedWorkspace: Readonly<Ref<import('../model/workbench.js').Workspace | undefined>>;
  readonly workspaceHost: Readonly<Ref<import('../model/workbench.js').NodeSummary | undefined>>;
  readonly view: Readonly<Ref<string>>;
  readonly mainSurfaceVisible: Readonly<Ref<boolean>>;
  readonly draftSessionOpen: Readonly<Ref<boolean>>;
  readonly selectedSessionId: Readonly<Ref<string | undefined>>;
  readonly mainLoading: Readonly<Ref<boolean>>;
  readonly asideVisible: Readonly<Ref<boolean>>;
  readonly asideTarget: Readonly<
    Ref<
      | { readonly nodeId: string; readonly workspaceId: string; readonly sessionId: string }
      | undefined
    >
  >;
  readonly asideLoading: Readonly<Ref<boolean>>;
  readonly markSessionRead: (
    nodeId: string,
    workspaceId: string,
    sessionId: string
  ) => void | Promise<void>;
}) {
  const {
    workspaceTarget,
    selectedWorkspace,
    workspaceHost,
    view,
    mainSurfaceVisible,
    draftSessionOpen,
    selectedSessionId,
    asideVisible,
    asideTarget,
    asideLoading
  } = input;
  function visibleWorkspaceNotificationTargets(includeLoading = false): readonly {
    nodeId: string;
    workspaceId: string;
    sessionId: string;
  }[] {
    const workspace = workspaceTarget.value;
    if (
      view.value !== 'nodes' ||
      workspace === undefined ||
      selectedWorkspace.value === undefined ||
      workspaceHost.value?.connected === false
    )
      return [];
    const targets: { nodeId: string; workspaceId: string; sessionId: string }[] = [];
    if (
      mainSurfaceVisible.value &&
      !draftSessionOpen.value &&
      selectedSessionId.value !== undefined &&
      (includeLoading || !input.mainLoading.value)
    )
      targets.push({ ...workspace, sessionId: selectedSessionId.value });
    if (
      asideVisible.value &&
      asideTarget.value !== undefined &&
      (includeLoading || !asideLoading.value) &&
      !targets.some((target) => target.sessionId === asideTarget.value?.sessionId)
    )
      targets.push({
        nodeId: asideTarget.value.nodeId,
        workspaceId: asideTarget.value.workspaceId,
        sessionId: asideTarget.value.sessionId
      });
    return targets;
  }
  function markVisibleSessionRead(
    nodeId: string,
    workspaceId: string,
    sessionId: string
  ): void | Promise<void> {
    if (
      visibleWorkspaceNotificationTargets(true).some(
        (target) =>
          target.nodeId === nodeId &&
          target.workspaceId === workspaceId &&
          target.sessionId === sessionId
      )
    )
      return input.markSessionRead(nodeId, workspaceId, sessionId);
  }

  return { targets: visibleWorkspaceNotificationTargets, markRead: markVisibleSessionRead };
}
