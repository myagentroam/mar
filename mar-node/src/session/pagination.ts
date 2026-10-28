export const DEFAULT_SESSION_PAGE_SIZE = 10;
export const MAX_SESSION_PAGE_SIZE = 100;

export function sessionPage<
  T extends {
    readonly id: string;
    readonly lastActivityAt: number;
    readonly pinOrder?: number | null;
    readonly externalDiscovered?: boolean;
  }
>(
  sessions: readonly T[],
  input: Record<string, unknown>
): { readonly sessions: readonly T[]; readonly nextCursor: string | null } {
  const limit =
    typeof input.limit === 'number' &&
    Number.isInteger(input.limit) &&
    input.limit >= 1 &&
    input.limit <= MAX_SESSION_PAGE_SIZE
      ? input.limit
      : DEFAULT_SESSION_PAGE_SIZE;
  const cursor = typeof input.cursor === 'string' ? input.cursor : undefined;
  const ordered = [...sessions].sort(compareSessionPageEntries);
  const cursorEntry = cursor === undefined ? undefined : parseSessionPageCursor(cursor);
  const afterCursor =
    cursor === undefined
      ? ordered
      : cursorEntry === undefined
        ? []
        : ordered.filter((session) => compareSessionPageEntries(session, cursorEntry) > 0);
  const pinned = ordered.filter(
    (session) => session.pinOrder !== null && session.pinOrder !== undefined
  );
  const pinnedIndexes = new Map(pinned.map((session, index) => [session.id, index]));
  const page = afterCursor.slice(0, limit).map((session) => {
    const pinIndex = pinnedIndexes.get(session.id);
    if (pinIndex === undefined) return session;
    return {
      ...session,
      canMovePinUp: pinIndex > 0,
      canMovePinDown: pinIndex < pinned.length - 1
    };
  });
  const last = page.at(-1);
  return {
    sessions: page,
    nextCursor:
      last !== undefined && afterCursor.length > page.length ? createSessionPageCursor(last) : null
  };
}

export function parseSessionPageCursor(cursor: string):
  | {
      readonly id: string;
      readonly lastActivityAt: number;
      readonly pinOrder: number | null;
      readonly externalDiscovered: boolean;
    }
  | undefined {
  try {
    const value = JSON.parse(decodeURIComponent(cursor)) as unknown;
    if (!Array.isArray(value) || value.length !== 3) return undefined;
    const [pinOrder, lastActivityAt, id] = value;
    if (
      (pinOrder !== null && (typeof pinOrder !== 'number' || !Number.isFinite(pinOrder))) ||
      (lastActivityAt !== null &&
        (typeof lastActivityAt !== 'number' || !Number.isFinite(lastActivityAt))) ||
      typeof id !== 'string'
    )
      return undefined;
    return {
      id,
      lastActivityAt: lastActivityAt ?? 0,
      pinOrder,
      externalDiscovered: lastActivityAt !== null
    };
  } catch {
    return undefined;
  }
}

export function createSessionPageCursor(session: {
  readonly id: string;
  readonly lastActivityAt: number;
  readonly pinOrder?: number | null;
  readonly externalDiscovered?: boolean;
}): string {
  return encodeURIComponent(
    JSON.stringify([
      session.pinOrder ?? null,
      session.externalDiscovered === false ? null : session.lastActivityAt,
      session.id
    ])
  );
}

export function compareSessionPageEntries(
  left: {
    readonly id: string;
    readonly lastActivityAt: number;
    readonly pinOrder?: number | null;
    readonly externalDiscovered?: boolean;
  },
  right: {
    readonly id: string;
    readonly lastActivityAt: number;
    readonly pinOrder?: number | null;
    readonly externalDiscovered?: boolean;
  }
): number {
  const leftPinned = left.pinOrder !== null && left.pinOrder !== undefined;
  const rightPinned = right.pinOrder !== null && right.pinOrder !== undefined;
  if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
  if (leftPinned && rightPinned)
    return (
      (left.pinOrder as number) - (right.pinOrder as number) || left.id.localeCompare(right.id)
    );
  const leftFound = left.externalDiscovered !== false;
  const rightFound = right.externalDiscovered !== false;
  if (leftFound !== rightFound) return leftFound ? -1 : 1;
  return right.lastActivityAt - left.lastActivityAt || left.id.localeCompare(right.id, 'en');
}
