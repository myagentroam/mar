import { randomUUID } from 'node:crypto';

interface IpcProcess {
  readonly connected?: boolean | undefined;
  send?: ((message: unknown, callback: (error: Error | null) => void) => boolean) | undefined;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  off(event: 'message', listener: (message: unknown) => void): unknown;
}

/** Parent capability is established once at startup; a handoff is never retried. */
export class SupervisorUpgradeHandoff {
  private readonly channelId = randomUUID();
  private supported = false;
  private uncertain = false;
  private handshakeResolve: ((supported: boolean) => void) | undefined;
  private pending: { id: string; resolve(): void; reject(error: Error): void } | undefined;

  constructor(private readonly parent: IpcProcess = process) {
    parent.on('message', this.onMessage);
  }

  async handshake(): Promise<boolean> {
    if (!this.parent.connected || this.parent.send === undefined) return false;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.handshakeResolve = undefined;
        resolve(false);
      }, 1_000);
      timer.unref();
      this.handshakeResolve = (supported) => {
        clearTimeout(timer);
        this.handshakeResolve = undefined;
        resolve(supported);
      };
      try {
        this.parent.send!({ type: 'node-upgrade-hello', channelId: this.channelId }, (error) => {
          if (error !== null) this.handshakeResolve?.(false);
        });
      } catch {
        this.handshakeResolve?.(false);
      }
    });
  }

  async handoff(input: {
    attemptId: string;
    targetVersion: string;
    credential: string;
  }): Promise<void> {
    if (!this.supported || !this.parent.connected || this.parent.send === undefined)
      throw new Error('NODE_UPGRADE_HANDOFF_UNAVAILABLE');
    if (this.uncertain) throw new Error('NODE_UPGRADE_HANDOFF_UNCERTAIN');
    if (this.pending !== undefined) throw new Error('NODE_UPGRADE_HANDOFF_ALREADY_PENDING');
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = undefined;
        this.uncertain = true;
        reject(new Error('NODE_UPGRADE_HANDOFF_UNCERTAIN'));
      }, 5_000);
      timer.unref();
      this.pending = {
        id,
        resolve: () => {
          clearTimeout(timer);
          this.pending = undefined;
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          this.pending = undefined;
          reject(error);
        }
      };
      try {
        this.parent.send!(
          { type: 'node-upgrade-handoff', channelId: this.channelId, id, ...input },
          (error) => {
            if (error !== null && this.pending?.id === id)
              this.pending.reject(new Error('NODE_UPGRADE_HANDOFF_UNAVAILABLE'));
          }
        );
      } catch {
        this.pending?.reject(new Error('NODE_UPGRADE_HANDOFF_UNAVAILABLE'));
      }
    });
  }

  close(): void {
    this.parent.off('message', this.onMessage);
    this.handshakeResolve?.(false);
    this.pending?.reject(new Error('NODE_UPGRADE_HANDOFF_UNCERTAIN'));
  }

  private readonly onMessage = (message: unknown): void => {
    if (typeof message !== 'object' || message === null) return;
    const value = message as Record<string, unknown>;
    if (value['channelId'] !== this.channelId) return;
    if (value['type'] === 'node-upgrade-ready' && this.handshakeResolve !== undefined) {
      this.supported = true;
      this.handshakeResolve?.(true);
      this.handshakeResolve = undefined;
    } else if (value['type'] === 'node-upgrade-ack') {
      const pending = this.pending;
      if (pending === undefined || value['id'] !== pending.id) return;
      if (value['accepted'] === true) pending.resolve();
      else pending.reject(new Error('NODE_UPGRADE_HANDOFF_REJECTED'));
    }
  };
}
