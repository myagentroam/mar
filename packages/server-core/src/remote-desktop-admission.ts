import type { DirectTransferBrowserIdentity } from './direct-transfer-coordinator.js';

const OPEN_MS = 15_000;
const SETUP_MS = 15_000;
const LEASE_MS = 30_000;

export interface DesktopAdmissionBinding extends DirectTransferBrowserIdentity {
  readonly attachmentId: string;
  readonly requestId: string;
  readonly nodeId: string;
  readonly nodeGeneration: string;
  readonly desktopGeneration: string;
  readonly topologyRevision: number;
  readonly mode: 'VIEW' | 'CONTROL';
  readonly path: 'DIRECT' | 'RELAY';
}

type Phase = 'RESERVED' | 'PREPARED' | 'SETTING_UP' | 'ATTACHED' | 'ACTIVE' | 'CLOSING';
interface Admission extends DesktopAdmissionBinding {
  phase: Phase;
  dispatched: boolean;
  browserReady: boolean;
  pageGone: boolean;
  readonly openExpiresAt: number;
  setupExpiresAt?: number;
  expiresAt: number;
}

/** Server-side attachment phase owner shared by Direct and relay, not a transport or input writer. */
export class RemoteDesktopAdmission {
  readonly #entries = new Map<string, Admission>();

  reserve(binding: DesktopAdmissionBinding, now: number): Readonly<Admission> | undefined {
    if (
      this.#entries.has(binding.attachmentId) ||
      [...this.#entries.values()].some(
        (entry) =>
          entry.workbenchConnectionId === binding.workbenchConnectionId &&
          entry.requestId === binding.requestId
      )
    )
      return undefined;
    const entry: Admission = {
      ...binding,
      phase: 'RESERVED',
      dispatched: false,
      browserReady: false,
      pageGone: false,
      openExpiresAt: now + OPEN_MS,
      expiresAt: now + LEASE_MS
    };
    this.#entries.set(entry.attachmentId, entry);
    return { ...entry };
  }

  get(attachmentId: string): Readonly<Admission> | undefined {
    const entry = this.#entries.get(attachmentId);
    return entry && { ...entry };
  }

  countNode(nodeId: string): number {
    return [...this.#entries.values()].filter((entry) => entry.nodeId === nodeId).length;
  }

  dispatched(attachmentId: string, now: number): boolean {
    const entry = this.#entries.get(attachmentId);
    if (!entry || entry.phase !== 'RESERVED' || entry.dispatched || this.#expired(entry, now))
      return false;
    entry.dispatched = true;
    return true;
  }

  /** Only for a transport that definitely rejected submission before writing anything. */
  notSubmitted(attachmentId: string): boolean {
    const entry = this.#entries.get(attachmentId);
    if (!entry || entry.phase !== 'RESERVED' || !entry.dispatched) return false;
    this.#entries.delete(attachmentId);
    return true;
  }

  prepared(attachmentId: string, nodeId: string, generation: string, now: number): boolean {
    const entry = this.#nodeEntry(attachmentId, nodeId, generation);
    if (!entry || entry.phase !== 'RESERVED' || !entry.dispatched || this.#expired(entry, now))
      return false;
    entry.phase = 'PREPARED';
    return true;
  }

  open(attachmentId: string, nodeId: string, generation: string, now: number): boolean {
    const entry = this.#nodeEntry(attachmentId, nodeId, generation);
    if (!entry || entry.phase !== 'PREPARED' || this.#expired(entry, now)) return false;
    entry.phase = 'SETTING_UP';
    entry.setupExpiresAt = now + SETUP_MS;
    return true;
  }

  attached(attachmentId: string, nodeId: string, generation: string, now: number): boolean {
    const entry = this.#nodeEntry(attachmentId, nodeId, generation);
    if (!entry || entry.phase !== 'SETTING_UP' || this.#expired(entry, now)) return false;
    entry.phase = 'ATTACHED';
    return true;
  }

  browserReady(
    attachmentId: string,
    identity: DirectTransferBrowserIdentity,
    now: number
  ): boolean {
    const entry = this.#browserEntry(attachmentId, identity);
    // The page's data channel can outrun Node lifecycle events on the control connection.
    if (
      !entry ||
      !['PREPARED', 'SETTING_UP', 'ATTACHED'].includes(entry.phase) ||
      entry.browserReady ||
      this.#expired(entry, now)
    )
      return false;
    entry.browserReady = true;
    return true;
  }

  active(attachmentId: string, nodeId: string, generation: string, now: number): boolean {
    const entry = this.#nodeEntry(attachmentId, nodeId, generation);
    if (!entry || entry.phase !== 'ATTACHED' || !entry.browserReady || this.#expired(entry, now))
      return false;
    entry.phase = 'ACTIVE';
    return true;
  }

  heartbeat(attachmentId: string, identity: DirectTransferBrowserIdentity, now: number): boolean {
    const entry = this.#browserEntry(attachmentId, identity);
    if (!entry || entry.phase === 'CLOSING' || this.#expired(entry, now)) return false;
    entry.expiresAt = now + LEASE_MS;
    return true;
  }

  /** Close is synchronous to fence admission; dispatched entries remain until Node settles. */
  beginClose(attachmentId: string): Readonly<Admission> | undefined {
    const entry = this.#entries.get(attachmentId);
    if (!entry || entry.phase === 'CLOSING') return undefined;
    entry.phase = 'CLOSING';
    if (!entry.dispatched) this.#entries.delete(attachmentId);
    return { ...entry };
  }

  closeForBrowser(
    attachmentId: string,
    identity: DirectTransferBrowserIdentity
  ): Readonly<Admission> | undefined {
    return this.#browserEntry(attachmentId, identity) ? this.beginClose(attachmentId) : undefined;
  }

  closeForConnection(
    connectionId: string,
    path?: 'DIRECT' | 'RELAY'
  ): readonly Readonly<Admission>[] {
    for (const entry of this.#entries.values()) {
      if (entry.workbenchConnectionId === connectionId && (!path || entry.path === path))
        entry.pageGone = true;
    }
    return this.#closeMatching(
      (entry) => entry.workbenchConnectionId === connectionId && (!path || entry.path === path)
    );
  }

  /** After a page is gone and its lease expires, Node owns any remaining cleanup. */
  retireExpiredGonePages(now: number, path: 'DIRECT' | 'RELAY'): readonly Readonly<Admission>[] {
    const retired: Readonly<Admission>[] = [];
    for (const entry of this.#entries.values()) {
      if (
        entry.path !== path ||
        !entry.pageGone ||
        entry.phase !== 'CLOSING' ||
        now < entry.expiresAt
      )
        continue;
      retired.push({ ...entry });
      this.#entries.delete(entry.attachmentId);
    }
    return retired;
  }

  closeForSession(sessionHash: string, path?: 'DIRECT' | 'RELAY'): readonly Readonly<Admission>[] {
    return this.#closeMatching(
      (entry) => entry.sessionHash === sessionHash && (!path || entry.path === path)
    );
  }

  closeForUser(userId: number, path?: 'DIRECT' | 'RELAY'): readonly Readonly<Admission>[] {
    return this.#closeMatching(
      (entry) => entry.userId === userId && (!path || entry.path === path)
    );
  }

  closeForNode(nodeId: string, path?: 'DIRECT' | 'RELAY'): readonly Readonly<Admission>[] {
    return this.#closeMatching(
      (entry) => entry.nodeId === nodeId && (!path || entry.path === path)
    );
  }

  /** Forget old-process bookkeeping, without asserting that native cleanup completed. */
  retireOtherGenerations(
    nodeId: string,
    currentGeneration: string,
    path: 'DIRECT' | 'RELAY'
  ): readonly Readonly<Admission>[] {
    const retired: Readonly<Admission>[] = [];
    for (const entry of this.#entries.values()) {
      if (
        entry.nodeId !== nodeId ||
        entry.nodeGeneration === currentGeneration ||
        entry.path !== path
      )
        continue;
      retired.push({ ...entry });
      this.#entries.delete(entry.attachmentId);
    }
    return retired;
  }

  closeAll(path?: 'DIRECT' | 'RELAY'): readonly Readonly<Admission>[] {
    return this.#closeMatching((entry) => !path || entry.path === path);
  }

  settled(attachmentId: string, nodeId: string, generation: string): boolean {
    const entry = this.#nodeEntry(attachmentId, nodeId, generation);
    if (!entry || entry.phase !== 'CLOSING') return false;
    this.#entries.delete(attachmentId);
    return true;
  }

  expire(now: number, path?: 'DIRECT' | 'RELAY'): readonly Readonly<Admission>[] {
    return this.#closeMatching(
      (entry) => (!path || entry.path === path) && this.#expired(entry, now)
    );
  }

  /** Dispatched closures are retried until the owning Node confirms cleanup. */
  pendingClosures(path: 'DIRECT' | 'RELAY'): readonly Readonly<Admission>[] {
    return [...this.#entries.values()]
      .filter((entry) => entry.path === path && entry.phase === 'CLOSING' && entry.dispatched)
      .map((entry) => ({ ...entry }));
  }

  #closeMatching(predicate: (entry: Admission) => boolean): readonly Readonly<Admission>[] {
    const expired: Readonly<Admission>[] = [];
    for (const entry of this.#entries.values()) {
      if (entry.phase !== 'CLOSING' && predicate(entry)) {
        const closing = this.beginClose(entry.attachmentId);
        if (closing) expired.push(closing);
      }
    }
    return expired;
  }

  #expired(entry: Admission, now: number): boolean {
    return (
      entry.expiresAt <= now ||
      ((entry.phase === 'RESERVED' || entry.phase === 'PREPARED') && entry.openExpiresAt <= now) ||
      ((entry.phase === 'SETTING_UP' || entry.phase === 'ATTACHED') && entry.setupExpiresAt! <= now)
    );
  }

  #nodeEntry(id: string, nodeId: string, generation: string): Admission | undefined {
    const entry = this.#entries.get(id);
    return entry?.nodeId === nodeId && entry.nodeGeneration === generation ? entry : undefined;
  }

  #browserEntry(id: string, identity: DirectTransferBrowserIdentity): Admission | undefined {
    const entry = this.#entries.get(id);
    return entry &&
      entry.userId === identity.userId &&
      entry.sessionHash === identity.sessionHash &&
      entry.workbenchConnectionId === identity.workbenchConnectionId
      ? entry
      : undefined;
  }
}
