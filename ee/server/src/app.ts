import { composeServerApplication } from './composition/server-application.js';
import type { ServerApplication, ServerAppOptions } from './composition/server-application.js';
import type { QuickStartNodeBootstrap } from './composition/quick-start-node-bootstrap.js';
import { createMysqlPool } from './mysql/connection.js';
import { MysqlServerDatabase } from './mysql/server-database.js';

export { auditedAction } from './composition/server-application.js';
export type { ServerApplication, ServerAppOptions } from './composition/server-application.js';

/** The product bootstrap always owns a MySQL-backed application. */
export async function createServerApp(
  options: ServerAppOptions = {}
): Promise<{ readonly app: ServerApplication }> {
  return createApplication(options, false);
}

/** Entry for the local-only deployment; it never reads a host UUID or enables activation. */
export async function createQuickStartServerApp(
  options: ServerAppOptions
): Promise<{ readonly app: ServerApplication; readonly quickStartNode: QuickStartNodeBootstrap }> {
  const composition = await createApplication(options, true);
  if (!composition.quickStartNode) throw new Error('QUICK_START_NODE_BOOTSTRAP_UNAVAILABLE');
  return { app: composition.app, quickStartNode: composition.quickStartNode };
}

async function createApplication(
  options: ServerAppOptions,
  quickStart: boolean
): Promise<import('./composition/server-application.js').ServerComposition> {
  const poolOptions = options.databaseUrl === undefined ? {} : { url: options.databaseUrl };
  const pool = createMysqlPool(poolOptions);
  let database: MysqlServerDatabase | undefined;
  let auditPool: ReturnType<typeof createMysqlPool> | undefined;
  try {
    auditPool = createMysqlPool({ ...poolOptions, connectionLimit: 4 });
    database = new MysqlServerDatabase(pool, options.now, auditPool);
    return await composeServerApplication(options, { database, pool }, quickStart);
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
