export type SessionWatchSlotKind = 'session' | 'hosted-conversation';
export type SessionWatchSlotToken = symbol;
export type SessionWatchPosition = 'primary' | 'secondary';

interface SessionWatchSlot {
  readonly kind: SessionWatchSlotKind;
  readonly token: SessionWatchSlotToken;
  readonly release: () => void;
}

/** Coordinates bounded ordinary positions and the mutually exclusive hosted watch. */
export class SessionWatchSlotCoordinator {
  private readonly slots = new Map<
    string,
    Map<SessionWatchPosition | 'hosted', SessionWatchSlot>
  >();

  replace(
    ownerKey: string,
    kind: SessionWatchSlotKind,
    release: () => void,
    position: SessionWatchPosition = 'primary'
  ): SessionWatchSlotToken {
    const key = kind === 'session' ? position : 'hosted';
    const previous = this.slots.get(ownerKey);
    if (previous !== undefined) {
      for (const [slotKey, slot] of previous) {
        if (kind === 'hosted-conversation' || slotKey === 'hosted' || slotKey === key) {
          previous.delete(slotKey);
          slot.release();
        }
      }
    }
    const token = Symbol(kind);
    const slots = this.slots.get(ownerKey) ?? new Map();
    slots.set(key, { kind, token, release });
    this.slots.set(ownerKey, slots);
    return token;
  }

  owns(ownerKey: string, token: SessionWatchSlotToken): boolean {
    return [...(this.slots.get(ownerKey)?.values() ?? [])].some((slot) => slot.token === token);
  }

  release(ownerKey: string, token: SessionWatchSlotToken): void {
    const slots = this.slots.get(ownerKey);
    if (slots === undefined) return;
    for (const [key, slot] of slots) {
      if (slot.token === token) slots.delete(key);
    }
    if (slots.size === 0) this.slots.delete(ownerKey);
  }
}
