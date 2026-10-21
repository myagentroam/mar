import { computed, ref, type Ref } from 'vue';
import { isMobileNotificationClient } from '../util/notification-capability.js';
import type { ServerNotification } from '@myagentroam/protocol';
import { createWebPushSubscriptionService } from './WebPushSubscriptionService.js';

export function isWorkbenchForeground(): boolean {
  return (
    typeof document === 'undefined' ||
    (document.visibilityState === 'visible' && (document.hasFocus?.() ?? true))
  );
}

export function createWorkbenchSystemNotificationService(
  username: Ref<string | undefined>,
  openNotification: (id: string) => Promise<void>,
  request?: <T>(path: string, init?: RequestInit) => Promise<T>
) {
  const push = createWebPushSubscriptionService(username, request);
  const mode = isMobileNotificationClient() ? 'mobile-push' : 'desktop-system';
  const pendingDisplays = new Map<string, () => boolean>();
  const enabled = ref(false);
  const permission = ref<NotificationPermission>('default');
  const unavailable = ref(false);
  const requesting = ref(false);
  let generation = 0;
  let activeAccount: string | undefined;
  const projectionOwner = Math.random().toString(36).slice(2);
  let projectionSequence = 0;

  function supported(): boolean {
    return (
      typeof Notification !== 'undefined' &&
      typeof navigator !== 'undefined' &&
      'serviceWorker' in navigator
    );
  }

  const status = computed(() => {
    if (typeof window !== 'undefined' && !globalThis.isSecureContext) return 'insecure';
    if (!supported()) return 'unsupported';
    if (unavailable.value) return 'unavailable';
    if (permission.value === 'denied') return 'denied';
    return enabled.value && permission.value === 'granted' ? 'enabled' : 'disabled';
  });

  function storageKey(account: string): string {
    return `mar.workbench.system-notifications.v1.${account}`;
  }

  function refreshPermission(): void {
    if (supported()) permission.value = Notification.permission;
  }

  function onFocus(): void {
    refreshPermission();
    if (mode === 'mobile-push') void push.refresh(enabled.value);
  }

  function save(account: string): void {
    try {
      localStorage.setItem(storageKey(account), String(enabled.value));
    } catch {
      // The opt-in still applies to this page if browser storage is unavailable.
    }
  }

  async function closeNotifications(account: string): Promise<void> {
    if (!supported()) return;
    const currentGeneration = generation;
    try {
      const registration = await navigator.serviceWorker.getRegistration('/console');
      const notifications = await registration?.getNotifications();
      if (generation !== currentGeneration && activeAccount === account) return;
      for (const notification of notifications ?? []) {
        if (
          notification.data?.type === 'mar.workbench.notification' &&
          notification.data.account === account
        )
          notification.close();
      }
    } catch {
      // System notification cleanup must not block logout or the in-page center.
    }
  }

  async function setEnabled(value: boolean): Promise<void> {
    const account = username.value;
    if (account === undefined || (value && requesting.value)) return;
    if (value && (!supported() || !globalThis.isSecureContext)) return;
    const currentGeneration = ++generation;
    const current = () => generation === currentGeneration && username.value === account;
    if (!value) {
      enabled.value = false;
      requesting.value = false;
      save(account);
      if (mode === 'mobile-push') await push.disable();
      await closeNotifications(account);
      return;
    }
    requesting.value = true;
    unavailable.value = false;
    try {
      // subscribe() owns the permission prompt when Push is available. Never start two prompts.
      const preparedPush = mode === 'mobile-push';
      if (preparedPush && !push.canSubscribe()) {
        await push.refresh(enabled.value);
        return;
      }
      const result = preparedPush
        ? await push.enable().then(() => Notification.permission)
        : await Notification.requestPermission();
      if (!current()) return;
      permission.value = result;
      if (result !== 'granted') return;
      const registration = await navigator.serviceWorker.getRegistration('/console');
      if (!current()) return;
      if (registration?.active == null || registration.showNotification === undefined) {
        unavailable.value = true;
        return;
      }
      enabled.value = true;
      save(account);
    } catch {
      if (current()) unavailable.value = true;
    } finally {
      if (current()) requesting.value = false;
    }
  }

  async function show(
    notification: ServerNotification,
    isCurrent: () => boolean = () => true
  ): Promise<void> {
    refreshPermission();
    const account = username.value;
    const currentGeneration = generation;
    const canShow = () =>
      generation === currentGeneration &&
      username.value === account &&
      account !== undefined &&
      activeAccount === account &&
      status.value === 'enabled' &&
      mode === 'desktop-system' &&
      !isWorkbenchForeground() &&
      !notification.read &&
      notification.expiresAt > Date.now() &&
      isCurrent();
    if (!canShow()) return;
    try {
      const registration = await navigator.serviceWorker.getRegistration('/console');
      if (!canShow() || registration?.active == null) return;
      const projectionId = `${projectionOwner}:${++projectionSequence}`;
      pendingDisplays.set(projectionId, canShow);
      try {
        await new Promise<void>((resolve) => {
          const channel = new MessageChannel();
          const finish = () => {
            clearTimeout(timeout);
            channel.port1.close();
            resolve();
          };
          const timeout = setTimeout(finish, 2500);
          channel.port1.onmessage = finish;
          registration.active!.postMessage(
            {
              type: 'mar.workbench.notification.show',
              account,
              id: notification.id,
              title: notification.title,
              body: notification.message,
              expiresAt: notification.expiresAt,
              projectionId
            },
            [channel.port2]
          );
        });
      } finally {
        pendingDisplays.delete(projectionId);
      }
    } catch {
      // Notifications are an optional projection; the Server list remains authoritative.
    }
  }

  function onMessage(event: MessageEvent): void {
    const data = event.data;
    if (data?.type === 'mar.workbench.notification.state') {
      const accepted = data.account === activeAccount && data.account === username.value;
      const valid =
        accepted &&
        (data.projectionId === undefined || pendingDisplays.get(data.projectionId)?.() === true);
      event.ports?.[0]?.postMessage({ valid, foreground: accepted && isWorkbenchForeground() });
      event.ports?.[0]?.close();
      return;
    }
    if (data?.type !== 'mar.workbench.notification.click') return;
    const accepted =
      typeof data.account === 'string' &&
      data.account === username.value &&
      data.account === activeAccount &&
      typeof data.id === 'string';
    const reply = event.ports?.[0];
    reply?.postMessage({ accepted });
    reply?.close();
    if (!accepted) return;
    void openNotification(data.id).catch(() => undefined);
  }

  function onStorage(event: StorageEvent): void {
    if (activeAccount === undefined || event.key !== storageKey(activeAccount)) return;
    const next = event.newValue === 'true';
    if (enabled.value === next && !requesting.value) return;
    generation += 1;
    requesting.value = false;
    enabled.value = next;
    refreshPermission();
    if (!enabled.value) {
      if (mode === 'mobile-push') void push.disable();
      void closeNotifications(activeAccount);
    } else if (mode === 'mobile-push') void push.refresh(true);
  }

  async function openPending(): Promise<boolean> {
    if (typeof window === 'undefined') return false;
    const url = new URL(window.location.href);
    const id = url.searchParams.get('notification');
    const account = url.searchParams.get('notificationAccount');
    if (id === null) return false;
    url.searchParams.delete('notification');
    url.searchParams.delete('notificationAccount');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    if (account !== username.value) return false;
    await openNotification(id).catch(() => undefined);
    return true;
  }

  function hasPending(): boolean {
    if (typeof window === 'undefined') return false;
    const url = new URL(window.location.href);
    return (
      url.searchParams.has('notification') &&
      url.searchParams.get('notificationAccount') === username.value
    );
  }

  function start(): void {
    generation += 1;
    requesting.value = false;
    refreshPermission();
    unavailable.value = false;
    const account = username.value;
    activeAccount = account;
    void push.invalidate();
    try {
      enabled.value = account !== undefined && localStorage.getItem(storageKey(account)) === 'true';
    } catch {
      enabled.value = false;
    }
    if (supported()) navigator.serviceWorker.addEventListener('message', onMessage);
    void push.refresh(enabled.value);
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', onFocus);
      window.addEventListener('storage', onStorage);
    }
  }

  function dispose(): void {
    generation += 1;
    pendingDisplays.clear();
    enabled.value = false;
    requesting.value = false;
    if (supported()) navigator.serviceWorker.removeEventListener('message', onMessage);
    if (typeof window !== 'undefined') {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('storage', onStorage);
    }
    const account = activeAccount;
    activeAccount = undefined;
    push.dispose();
    if (account !== undefined) void closeNotifications(account);
  }

  return {
    enabled,
    mode,
    pushReady: push.canSubscribe,
    status,
    requesting,
    pushStatus: push.status,
    enablePush: push.enable,
    invalidatePush: push.invalidate,
    setEnabled,
    show,
    start,
    dispose,
    openPending,
    hasPending
  };
}
