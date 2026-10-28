import { composeServerApplication } from './composition/server-application.js';
import type { ServerApplication, ServerAppOptions } from './composition/server-application.js';
import { createMysqlPool } from './mysql/connection.js';
import { MysqlServerDatabase } from './mysql/server-database.js';

export { auditedAction } from './composition/server-application.js';
export type { ServerApplication, ServerAppOptions } from './composition/server-application.js';

/** The product bootstrap always owns a MySQL-backed application. */
export async function createServerApp(
  options: ServerAppOptions = {}
): Promise<{ readonly app: ServerApplication }> {
  const poolOptions = options.databaseUrl === undefined ? {} : { url: options.databaseUrl };
  const pool = createMysqlPool(poolOptions);
  let database: MysqlServerDatabase | undefined;
  let auditPool: ReturnType<typeof createMysqlPool> | undefined;
  try {
    auditPool = createMysqlPool({ ...poolOptions, connectionLimit: 4 });
    database = new MysqlServerDatabase(pool, options.now, auditPool);
    return await composeServerApplication(options, { database, pool });
  } catch (error) {
    try {
      if (database !== undefined) await database.close();
      else {
        const results = await Promise.allSettled([
          pool.end(),
          ...(auditPool ? [auditPool.end()] : [])
        ]);
        const failures = results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : []
        );
        if (failures.length > 0) throw new AggregateError(failures, 'Failed to close Server pools');
      }
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Failed to construct Server application', {
        cause: error
      });
    }
    throw error;
  }
}
