import type { FastifyInstance } from 'fastify';
import { registerAuthenticationRoutes } from '@myagentroam/server-core/auth-routes';
import type { UserLocalePreferences } from '@myagentroam/server-core/auth-contracts';
import type { LoginRateRecord } from '@myagentroam/server-core/login-rate';
import type { ProductCapabilityProvider } from '@myagentroam/server-core/product-capabilities';
import type { ServerDatabase } from '../database.js';
import type { MysqlServerDatabase } from '../mysql/server-database.js';
import type { NodeControl } from '../node-control.js';

export function registerAuthRoutes(input: {
  readonly app: FastifyInstance;
  readonly database: ServerDatabase | MysqlServerDatabase;
  readonly nodeControl: Pick<
    NodeControl,
    'closeUserTerminals' | 'closeUserWorkbench' | 'closeAllTerminals' | 'closeAllWorkbench'
  >;
  readonly publicOrigin: string | undefined;
  readonly secureCookies: boolean;
  readonly now: () => number;
  readonly loginRate: Map<string, LoginRateRecord>;
  readonly productCapabilities?: ProductCapabilityProvider;
  readonly notifications?: UserLocalePreferences;
}): void {
  const { database, nodeControl } = input;
  registerAuthenticationRoutes({
    app: input.app,
    store: database,
    audit: { record: (event) => database.audit(event) },
    lifecycle: {
      closeSessionConnections(sessionHash) {
        nodeControl.closeUserTerminals(sessionHash);
        nodeControl.closeUserWorkbench(sessionHash);
      },
      closeAllConnections() {
        nodeControl.closeAllTerminals();
        nodeControl.closeAllWorkbench();
      }
    },
    publicOrigin: input.publicOrigin,
    secureCookies: input.secureCookies,
    now: input.now,
    loginRate: input.loginRate,
    ...(input.productCapabilities === undefined
      ? {}
      : { productCapabilities: input.productCapabilities }),
    ...(input.notifications === undefined ? {} : { localePreferences: input.notifications })
  });
}
