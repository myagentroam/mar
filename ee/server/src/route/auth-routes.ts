import type { FastifyInstance } from 'fastify';
import { registerAuthenticationRoutes } from '@myagentroam/server-core/auth-routes';
import type {
  AuthenticationAuditSink,
  AuthenticationStore,
  UserLocalePreferences
} from '@myagentroam/server-core/auth-contracts';
import type { LoginRateRecord } from '@myagentroam/server-core/login-rate';
import type { ProductCapabilityProvider } from '@myagentroam/server-core/product-capabilities';

export function registerAuthRoutes(input: {
  readonly app: FastifyInstance;
  readonly store: AuthenticationStore;
  readonly audit: AuthenticationAuditSink;
  readonly nodeControl: {
    closeUserTerminals(sessionHash: string): void;
    closeUserWorkbench(sessionHash: string): void;
    closeAllTerminals(): void;
    closeAllWorkbench(): void;
  };
  readonly publicOrigin: string | undefined;
  readonly secureCookies: boolean;
  readonly now: () => number;
  readonly loginRate: Map<string, LoginRateRecord>;
  readonly productCapabilities?: ProductCapabilityProvider;
  readonly notifications?: UserLocalePreferences;
}): void {
  const { nodeControl } = input;
  registerAuthenticationRoutes({
    app: input.app,
    store: input.store,
    audit: input.audit,
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
