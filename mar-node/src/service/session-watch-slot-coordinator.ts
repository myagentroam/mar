export type SessionWatchSlotKind = 'session' | 'hosted-conversation';
export type SessionWatchSlotToken = symbol;

interface SessionWatchSlot {
  readonly kind: SessionWatchSlotKind;
  readonly token: SessionWatchSlotToken;
  readonly release: () => void;
}

/** Coordinates the single Session Watch slot owned by one logical Workbench connection. */
export class SessionWatchSlotCoordinator {
  private readonly slots = new Map<string, SessionWatchSlot>();

  replace(
    ownerKey: string,
    kind: SessionWatchSlotKind,
    release: () => void
  ): SessionWatchSlotToken {
    const previous = this.slots.get(ownerKey);
    if (previous !== undefined) {
      this.slots.delete(ownerKey);
      previous.release();
    }
    const token = Symbol(kind);
    this.slots.set(ownerKey, { kind, token, release });
    return token;
  }

  owns(ownerKey: string, token: SessionWatchSlotToken): boolean {
    return this.slots.get(ownerKey)?.token === token;
  }

  release(ownerKey: string, token: SessionWatchSlotToken): void {
    if (this.slots.get(ownerKey)?.token === token) this.slots.delete(ownerKey);
  }
}
