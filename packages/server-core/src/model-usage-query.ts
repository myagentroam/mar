import type { Pool, RowDataPacket } from 'mysql2/promise';
import {
  MODEL_USAGE_RETENTION_MS,
  modelUsageRecordSchema,
  personalUsagePageSchema,
  type PersonalUsageOverview,
  type PersonalUsageQuery,
  type PersonalUsageRecords,
  type UsageGroup,
  type UsageTotals
} from '@myagentroam/protocol';
import { recordedUsage } from './model-usage-record.js';

const totalSql = `COALESCE(SUM(input_tokens),0) AS inputTokens,
  COALESCE(SUM(output_tokens),0) AS outputTokens, COUNT(*) AS requests,
  COALESCE(SUM(CAST(JSON_UNQUOTE(JSON_EXTRACT(record,'$.cacheReadTokens')) AS DECIMAL(38,0))),0) AS cacheReadTokens,
  COALESCE(SUM(CAST(JSON_UNQUOTE(JSON_EXTRACT(record,'$.cacheWriteTokens')) AS DECIMAL(38,0))),0) AS cacheWriteTokens,
  COUNT(*) AS completeRequests,
  0 AS partialRequests,
  0 AS unknownRequests`;
const countKeys = [
  'inputTokens',
  'outputTokens',
  'requests',
  'completeRequests',
  'partialRequests',
  'unknownRequests'
] as const;
const cacheKeys = ['cacheReadTokens', 'cacheWriteTokens'] as const;

export class ModelUsageQueryError extends Error {
  constructor(readonly code: 'USAGE_QUERY_INVALID' | 'USAGE_CURSOR_INVALID') {
    super('The personal usage query is invalid.');
  }
}

export function emptyUsageTotals(): UsageTotals {
  return {
    inputTokens: '0',
    outputTokens: '0',
    cacheReadTokens: '0',
    cacheWriteTokens: '0',
    totalTokens: '0',
    requests: '0',
    completeRequests: '0',
    partialRequests: '0',
    unknownRequests: '0'
  };
}
function totals(row: Record<string, unknown> | undefined): UsageTotals {
  const result = emptyUsageTotals();
  for (const key of countKeys) result[key] = String(row?.[key] ?? '0');
  for (const key of cacheKeys) result[key] = String(row?.[key] ?? '0');
  result.totalTokens = (BigInt(result.inputTokens) + BigInt(result.outputTokens)).toString();
  return result;
}
function add(target: UsageTotals, source: UsageTotals): void {
  for (const key of [...countKeys, 'totalTokens'] as const)
    target[key] = (BigInt(target[key]) + BigInt(source[key])).toString();
  for (const key of cacheKeys)
    if (source[key] !== null)
      target[key] = (BigInt(target[key] ?? '0') + BigInt(source[key])).toString();
}

function sameQuery(left: PersonalUsageQuery, right: PersonalUsageQuery): boolean {
  return (
    left.from === right.from &&
    left.to === right.to &&
    left.timeZone === right.timeZone &&
    left.runner === right.runner &&
    left.model === right.model &&
    left.mode === right.mode &&
    left.purpose === right.purpose
  );
}

/** Calendar boundaries use ICU, not optional MySQL time-zone tables. */
export function usageBucketRanges(
  from: number,
  to: number,
  timeZone: string
): { from: number; to: number }[] {
  const result: { from: number; to: number }[] = [];
  const hourly = to - from <= 86_400_000;
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  for (let start = from; start < to;) {
    let end = Math.min(to, start + 3_600_000);
    if (!hourly) {
      const label = date.format(start);
      let low = start;
      let high = Math.min(to, start + 21_600_000);
      while (high < to && date.format(high) === label) {
        low = high;
        high = Math.min(to, high + 21_600_000);
      }
      if (high === to && date.format(high - 1) === label) end = to;
      else {
        while (high - low > 1) {
          const middle = Math.floor((low + high) / 2);
          if (date.format(middle) === label) low = middle;
          else high = middle;
        }
        end = high;
      }
    }
    result.push({ from: start, to: end });
    start = end;
  }
  return result;
}

function filter(
  userId: number,
  query: PersonalUsageQuery,
  minimum: number
): { sql: string; values: (string | number)[] } {
  const values: (string | number)[] = [userId, Math.max(query.from, minimum), query.to];
  const parts = ['user_id=?', 'ended_at>=?', 'ended_at<?'];
  for (const [field, value] of [
    ['runner', query.runner],
    ['mode', query.mode],
    ['purpose', query.purpose ?? 'conversation']
  ] as const) {
    if (value !== undefined) {
      parts.push(`${field}=?`);
      values.push(value);
    }
  }
  if (query.model !== undefined) {
    parts.push('model_key=?', 'BINARY model_key=BINARY ?');
    values.push(query.model, query.model);
  }
  return { sql: parts.join(' AND '), values };
}

export class ModelUsageQueryService {
  constructor(
    private readonly pool: Pool,
    private readonly now = Date.now
  ) {}

  async overview(userId: number, query: PersonalUsageQuery): Promise<PersonalUsageOverview> {
    const asOf = this.now();
    const minimum = asOf - MODEL_USAGE_RETENTION_MS;
    const effectiveQuery = query.to > asOf ? { ...query, to: asOf } : query;
    const selected = filter(userId, effectiveQuery, minimum);
    const ranges = usageBucketRanges(
      Math.max(query.from, minimum),
      Math.min(query.to, asOf),
      query.timeZone
    );
    const connection = await this.pool.getConnection();
    try {
      await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await connection.beginTransaction();
      const [periods] = await connection.execute<RowDataPacket[]>(
        `SELECT ended_at>=? AS recent,${totalSql} FROM model_usage_records
        WHERE user_id=? AND purpose=? AND ended_at>=? AND ended_at<? GROUP BY recent`,
        [asOf - 86_400_000, userId, query.purpose ?? 'conversation', asOf - 7 * 86_400_000, asOf]
      );
      const last24Hours = emptyUsageTotals();
      const last7Days = emptyUsageTotals();
      for (const row of periods) {
        const value = totals(row);
        add(last7Days, value);
        if (Number(row.recent) === 1) add(last24Hours, value);
      }
      const [metadata] = await connection.execute<RowDataPacket[]>(
        `SELECT MIN(started_at) AS firstRecordedAt,MAX(received_at) AS lastReceivedAt
        FROM model_usage_records WHERE user_id=? AND purpose=? AND
        ((ended_at>=? AND ended_at<?) OR (ended_at IS NULL AND started_at>=? AND started_at<?))
        AND received_at<=?`,
        [userId, query.purpose ?? 'conversation', minimum, asOf, minimum, asOf, asOf]
      );
      const buckets = ranges.map((range) => ({ ...emptyUsageTotals(), ...range }));
      const runners = new Map<string, UsageGroup>();
      const models = new Map<string, UsageGroup>();
      const selectedTotals = emptyUsageTotals();
      if (ranges.length) {
        const bucketSql = `CASE ${ranges.map((_, i) => `WHEN ended_at<? THEN ${i}`).join(' ')} ELSE -1 END`;
        const [rows] = await connection.execute<RowDataPacket[]>(
          `SELECT ${bucketSql} AS bucket,runner,model_key,MAX(model_name) AS model_name,${totalSql}
          FROM model_usage_records WHERE ${selected.sql} AND ended_at<? GROUP BY bucket,runner,BINARY model_key,model_key`,
          [...ranges.map((range) => range.to), ...selected.values, asOf]
        );
        for (const row of rows) {
          const value = totals(row);
          const bucket = buckets[Number(row.bucket)];
          if (!bucket) continue;
          add(bucket, value);
          add(selectedTotals, value);
          for (const [map, key, label] of [
            [runners, String(row.runner), String(row.runner)],
            [models, String(row.model_key), String(row.model_name)]
          ] as const) {
            let group = map.get(key);
            if (!group) {
              group = { ...emptyUsageTotals(), key, label };
              map.set(key, group);
            }
            add(group, value);
          }
        }
      }
      await connection.commit();
      const sort = (map: Map<string, UsageGroup>) =>
        [...map.values()].sort((a, b) =>
          BigInt(a.totalTokens) === BigInt(b.totalTokens)
            ? a.key.localeCompare(b.key)
            : BigInt(a.totalTokens) > BigInt(b.totalTokens)
              ? -1
              : 1
        );
      return {
        asOf,
        availableFrom: minimum,
        firstRecordedAt:
          metadata[0]?.firstRecordedAt == null ? null : Number(metadata[0].firstRecordedAt),
        lastReceivedAt:
          metadata[0]?.lastReceivedAt == null ? null : Number(metadata[0].lastReceivedAt),
        last24Hours,
        last7Days,
        selected: selectedTotals,
        buckets,
        runners: sort(runners),
        models: sort(models),
        coverage: 'observed-only'
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async records(
    userId: number,
    query: PersonalUsageQuery,
    cursor?: string,
    requestedPage?: number
  ): Promise<PersonalUsageRecords> {
    if (
      requestedPage !== undefined &&
      (!personalUsagePageSchema.safeParse(requestedPage).success || cursor !== undefined)
    )
      throw new ModelUsageQueryError('USAGE_QUERY_INVALID');
    const asOf = this.now();
    const minimum = asOf - MODEL_USAGE_RETENTION_MS;
    const effectiveQuery = query.to > asOf ? { ...query, to: asOf } : query;
    const selected = filter(userId, effectiveQuery, minimum);
    const countValues = [...selected.values];
    let after = '';
    if (cursor !== undefined) {
      if (cursor.length > 4096) throw new ModelUsageQueryError('USAGE_CURSOR_INVALID');
      try {
        const value = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as {
          userId: number;
          query: PersonalUsageQuery;
          time: number;
          key: string;
        };
        if (
          value.userId !== userId ||
          !value.query ||
          !sameQuery(value.query, query) ||
          !Number.isSafeInteger(value.time) ||
          !/^[a-f0-9]{64}$/.test(value.key)
        )
          throw new Error();
        after = ' AND (ended_at<? OR (ended_at=? AND source_key<?))';
        selected.values.push(value.time, value.time, value.key);
      } catch {
        throw new ModelUsageQueryError('USAGE_CURSOR_INVALID');
      }
    }
    const connection = await this.pool.getConnection();
    try {
      await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await connection.beginTransaction();
      const [counts] = await connection.execute<RowDataPacket[]>(
        `SELECT CAST(COUNT(*) AS CHAR) AS total FROM model_usage_records WHERE ${selected.sql}`,
        countValues
      );
      const total = String(counts[0]?.total ?? '0');
      const pageNumber = Math.min(requestedPage ?? 1, Math.max(1, Math.ceil(Number(total) / 20)));
      const offset = requestedPage === undefined ? '' : ` OFFSET ${(pageNumber - 1) * 20}`;
      const [rows] = await connection.execute<RowDataPacket[]>(
        `SELECT source_key,ended_at,mode,record FROM model_usage_records WHERE ${selected.sql}${after} ORDER BY ended_at DESC,source_key DESC LIMIT 21${offset}`,
        selected.values
      );
      await connection.commit();
      const page = rows.slice(0, 20);
      const last = page.at(-1);
      return {
        total,
        page: pageNumber,
        records: page.map((row) => {
          const record = recordedUsage(
            modelUsageRecordSchema.parse(
              typeof row.record === 'string' ? JSON.parse(row.record) : row.record
            )
          );
          return {
            ...record,
            ledgerId: String(row.source_key),
            mode: row.mode as 'work' | 'conversation',
            totalTokens: (BigInt(record.inputTokens) + BigInt(record.outputTokens)).toString()
          };
        }),
        nextCursor:
          rows.length > 20 && last
            ? Buffer.from(
                JSON.stringify({
                  userId,
                  query,
                  time: Number(last.ended_at),
                  key: String(last.source_key)
                })
              ).toString('base64url')
            : null
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
}
