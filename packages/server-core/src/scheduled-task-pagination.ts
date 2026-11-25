interface ScheduledTaskSlice<T> {
  readonly total: number;
  readonly read: (offset: number, limit: number) => Promise<{ total: number; tasks: readonly T[] }>;
}

export class ScheduledTaskPageChanged extends Error {}

/** Reads just the target window from the already authorized, ordered Workspace sources. */
export async function readScheduledTaskPage<T>(
  sources: readonly ScheduledTaskSlice<T>[],
  requestedPage: number,
  pageSize: number
) {
  const total = sources.reduce((sum, source) => sum + source.total, 0);
  if (!Number.isSafeInteger(total)) throw new Error('NODE_RESPONSE_INVALID');
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, lastPage);
  let skip = (page - 1) * pageSize;
  let remaining = pageSize;
  const reads: Promise<readonly T[]>[] = [];
  for (const source of sources) {
    if (skip >= source.total) {
      skip -= source.total;
      continue;
    }
    const offset = skip;
    const limit = Math.min(remaining, source.total - offset);
    reads.push(
      source.read(offset, limit).then((result) => {
        if (result.total !== source.total || result.tasks.length !== limit)
          throw new ScheduledTaskPageChanged();
        return result.tasks;
      })
    );
    remaining -= limit;
    if (remaining === 0) break;
    skip = 0;
  }
  return {
    items: (await Promise.all(reads)).flat(),
    page,
    pageSize,
    total,
    hasMore: page < lastPage
  };
}
