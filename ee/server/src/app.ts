import { ModelUsageQueryService } from '@myagentroam/server-core/model-usage-query';
import { ModelUsageGrants } from '@myagentroam/server-core/model-usage-grant';
import { ModelUsageStore } from '@myagentroam/server-core/model-usage-store';
import { registerModelUsageRoutes } from '@myagentroam/server-core/model-usage-routes';
import serverPackage from '../package.json' with { type: 'json' };
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import { serverWorkbenchCapabilities } from '@myagentroam/server-core/runner-capabilities';
import { openServerDatabase } from './database.js';
import { NodeControl } from './node-control.js';
import { registerAuthRoutes } from './route/auth-routes.js';
import { registerManagementRoutes } from './route/management-routes.js';
import { registerRealtimeRoutes } from './route/realtime-routes.js';
import { registerNodeRoutes } from './route/node-routes.js';
import { registerWorkspaceRoutes } from './route/workspace-routes.js';
import { registerSessionRunRoutes } from './route/session-run-routes.js';
import { runtimeModelPayload } from '@myagentroam/server-core/run-model-payload';
import { registerRunControlRoutes } from './route/run-control-routes.js';
import { registerEnvironmentSecretRoutes } from './route/environment-secret-routes.js';
import { EnvironmentSecretService } from './service/environment-secret-service.js';
import { createMysqlPool, prepareMysqlDatabase } from './mysql/connection.js';
import { MysqlServerDatabase } from './mysql/server-database.js';
import { MysqlEnvironmentSecretService } from './mysql/environment-secret-service.js';
import { createEnterpriseServerProduct } from './composition/enterprise-product.js';
import { OrganizationService } from './rbac/organization-service.js';
import { registerOrganizationRoutes } from './route/organization-routes.js';
import { EnterpriseUserService } from './rbac/enterprise-user-service.js';
import { registerEnterpriseUserRoutes } from './route/enterprise-user-routes.js';
import { ResourceAccessService } from './rbac/resource-access-service.js';
import { registerResourceGrantRoutes } from './route/resource-grant-routes.js';
import { OAuthService } from './oauth/oauth-service.js';
import { registerOAuthRoutes } from './route/oauth-routes.js';
import { AuditService } from './audit/audit-service.js';
import { NodeUpgradeService } from './service/node-upgrade-service.js';
import { registerAuditRoutes } from './route/audit-routes.js';
import { SkillSourceService } from './skill/skill-source-service.js';
import { SkillDiscoveryService } from './skill/skill-discovery-service.js';
import { registerSkillSourceRoutes } from './route/skill-source-routes.js';
import { GithubSkillProvider } from './skill/github-skill-provider.js';
import { SkillFavoriteService } from './skill/skill-favorite-service.js';
import { registerSkillFavoriteRoutes } from './route/skill-favorite-routes.js';
import { SkillArtifactService } from './skill/skill-artifact-service.js';
import { RotatingLogStream } from './rotating-log-stream.js';
import { registerSkillTargetRoutes } from './route/skill-target-routes.js';
import { publicHttpsFetch, SkillNetworkPolicy } from './skill/skill-network-policy.js';
import { registerSystemSettingsRoutes } from './route/system-settings-routes.js';
import { MailSmtpService } from '@myagentroam/server-core/mail-smtp-service';
import { WebPushConfiguration } from '@myagentroam/server-core/web-push-configuration';
import { WebPushClients } from '@myagentroam/server-core/web-push-clients';
import {
  WebPushDispatcher,
  type WebPushTransport
} from '@myagentroam/server-core/web-push-dispatcher';
import { registerWebPushRoutes } from '@myagentroam/server-core/web-push-routes';
import { createWebPushTransport } from '@myagentroam/server-core/web-push-transport';
import { MailTemplateService } from '@myagentroam/server-core/mail-template-service';
import { registerMailRoutes } from '@myagentroam/server-core/mail-routes';
import { MailNotificationService } from '@myagentroam/server-core/mail-notification-service';
import { NotificationChannelService } from '@myagentroam/server-core/notification-channel-service';
import { HtmlPreviewOrigin } from '@myagentroam/server-core/html-preview-origin';
import { registerHtmlPreviewRoutes } from '@myagentroam/server-core/html-preview-routes';
import { SessionShares } from '@myagentroam/server-core/session-shares';
import { MysqlSessionShares } from '@myagentroam/server-core/mysql-session-shares';
import { SessionInputService } from '@myagentroam/server-core/session-input-service';
import { SessionChannelService } from '@myagentroam/server-core/session-channel-service';
import { registerSessionShareRoutes } from '@myagentroam/server-core/session-share-routes';
import { MarctlUserCredentials } from '@myagentroam/server-core/marctl-user-credentials';
import { registerMarctlRoutes } from '@myagentroam/server-core/marctl-routes';
import { McpService } from './mcp/mcp-service.js';
import { registerMcpRoutes } from './route/mcp-routes.js';
import { registerQuickPromptRoutes } from './route/quick-prompt-routes.js';
import { QuickPromptService } from './service/quick-prompt-service.js';
import { registerPersonalInstructionRoutes } from './route/personal-instruction-routes.js';
import { PersonalInstructionService } from './service/personal-instruction-service.js';
import { PersonalGitService } from '@myagentroam/server-core/personal-git-service';
import { registerPersonalGitRoutes } from '@myagentroam/server-core/personal-git-routes';
import { MarAgentModelService } from './service/mar-agent-model-service.js';
import { MarAgentResourceInputService } from '@myagentroam/server-core/mar-agent-resource-input-service';
import {
  MarAgentRuntimeModelService,
  MarAgentCompactService
} from './service/mar-agent-runtime-model-service.js';
import { ImageGenerationConfigurationService } from './service/image-generation-configuration-service.js';
import { CodexCredentialService } from './service/codex-credential-service.js';
import { CODEX_CREDENTIAL_MAINTENANCE_INTERVAL_MS } from '@myagentroam/server-core/codex-credential-service';
import {
  loadOrCreateRuntimeCredentialHmacKey,
  RuntimeCredentialService
} from './service/runtime-credential-service.js';
import { registerMarAgentModelRoutes } from './route/mar-agent-model-routes.js';
import { registerPromptCompletionRoutes } from '@myagentroam/server-core/prompt-completion-routes';
import { registerCodexCredentialRoutes } from './route/codex-credential-routes.js';
import { WorkbenchNotificationService } from './service/workbench-notification-service.js';
import { registerNotificationRoutes } from './route/notification-routes.js';
import { RecentRunService } from './service/recent-run-service.js';
import {
  databaseError,
  logCorrelation,
  safePublicError,
  sendError,
  type LoginRateRecord
} from './util/http-request.js';
import { ServerTrafficMetrics } from './service/server-traffic-metrics.js';
import { registerWebSearchRoutes } from './route/web-search-routes.js';
import { ConversationTemplateService } from './service/conversation-template-service.js';
import { registerConversationTemplateRoutes } from './route/conversation-template-routes.js';
import { registerHostedConversationRoutes } from './route/hosted-conversation-routes.js';
import { HostedConversationActivityService } from './service/hosted-conversation-activity-service.js';
import { registerWebStaticRoutes } from '@myagentroam/server-core/web-static-routes';

const serverVersion = typeof serverPackage.version === 'string' ? serverPackage.version : 'unknown';
const SERVER_WORKBENCH_CAPABILITIES = serverWorkbenchCapabilities(serverVersion);
// HTTP paths are request diagnostics, never business audit actions.
export function auditedAction(_method: string, _route: string): undefined {
  return undefined;
}

export interface ServerAppOptions {
  readonly webRoot?: string;
  readonly dataDirectory?: string;
  readonly databasePath?: string;
  readonly databaseUrl?: string;
  readonly secureCookies?: boolean;
  readonly publicOrigin?: string;
  readonly logger?: boolean;
  readonly now?: () => number;
  readonly productUuid?: string | null;
  readonly nodeUpgrades?: NodeUpgradeService;
  readonly webSearchEndpoint?: string;
  readonly webSearchFetch?: typeof fetch;
  readonly webPushTransport?: WebPushTransport;
}

export interface ServerApplication extends FastifyInstance {
  shutdown(): Promise<void>;
}

export function createServerApp(options: ServerAppOptions = {}): ServerApplication {
  const sqliteTestDatabase =
    options.databasePath === undefined
      ? undefined
      : openServerDatabase(
          options.databasePath,
          options.now === undefined ? {} : { now: options.now }
        );
  const mysqlPool =
    sqliteTestDatabase === undefined
      ? createMysqlPool({
          ...(options.databaseUrl === undefined ? {} : { url: options.databaseUrl })
        })
      : undefined;
  const database =
    sqliteTestDatabase ??
    new MysqlServerDatabase(
      mysqlPool!,
      options.now,
      createMysqlPool({
        ...(options.databaseUrl === undefined ? {} : { url: options.databaseUrl }),
        connectionLimit: 4
      })
    );
  const now = options.now ?? Date.now;
  const dataDirectory = resolve(options.dataDirectory ?? process.env['MAR_DATA_DIR'] ?? './data');
  const skillCacheDirectory = resolve(dataDirectory, 'skills');
  // Issue HTTPS-only cookies by default; callers must explicitly pass false for local plaintext development.
  const secureCookies = options.secureCookies ?? true;
  const publicOrigin = options.publicOrigin ?? process.env['MAR_PUBLIC_ORIGIN'];
  const userCredentials =
    mysqlPool === undefined ? undefined : new MarctlUserCredentials(mysqlPool, now);
  const loginRate = new Map<string, LoginRateRecord>();
  const app = Fastify({
    genReqId: () => `req-${randomUUID()}`,
    logController: new LogController({ disableRequestLogging: true }),
    logger:
      options.logger === true
        ? { stream: new RotatingLogStream(resolve(dataDirectory, 'logs'), 'server') }
        : false
  }) as unknown as ServerApplication;
  app.setNotFoundHandler((_request, reply) => sendError(reply, 404, 'ROUTE_NOT_FOUND'));
  if (options.webRoot !== undefined) registerWebStaticRoutes(app, options.webRoot);
  app.setErrorHandler((error, request, reply) => {
    const errorRecord =
      error !== null && typeof error === 'object' ? (error as Record<string, unknown>) : undefined;
    const rawStatusCode = errorRecord?.['statusCode'];
    const statusCode =
      typeof rawStatusCode === 'number' &&
      Number.isInteger(rawStatusCode) &&
      rawStatusCode >= 400 &&
      rawStatusCode < 500
        ? rawStatusCode
        : undefined;
    if (statusCode !== undefined) {
      const failure = safePublicError(
        error,
        statusCode === 413 ? 'REQUEST_BODY_TOO_LARGE' : 'REQUEST_INVALID'
      );
      return sendError(
        reply,
        statusCode,
        statusCode === 413 ? 'REQUEST_BODY_TOO_LARGE' : 'REQUEST_INVALID',
        failure.details === undefined ? {} : { details: failure.details }
      );
    }
    request.log.error(
      {
        event: 'request.failed',
        requestId: request.id,
        error: safePublicError(error).code,
        ...logCorrelation(request.params)
      },
      'request_failed'
    );
    return databaseError(reply, error);
  });
  const traffic = new ServerTrafficMetrics((event, fields) => app.log.info({ event, ...fields }));
  const nodeControl = new NodeControl(
    database,
    (event, fields) => app.log.info({ event, ...fields }),
    traffic
  );
  const recentRuns =
    sqliteTestDatabase === undefined
      ? new RecentRunService(
          database as MysqlServerDatabase,
          (userId, message) => nodeControl.pushUserWorkbench(userId, message),
          now
        )
      : undefined;
  if (recentRuns !== undefined)
    nodeControl.setRecentRunHandler(
      (nodeId, payload) => recentRuns.consume(nodeId, payload),
      (nodeId) => recentRuns.disconnected(nodeId)
    );
  const nodeUpgrades = options.nodeUpgrades ?? new NodeUpgradeService(serverVersion);
  const product =
    sqliteTestDatabase === undefined
      ? createEnterpriseServerProduct({
          database: database as MysqlServerDatabase,
          now,
          ...(process.env['MAR_LICENSE_PUBLIC_KEY'] === undefined
            ? {}
            : { publicKey: process.env['MAR_LICENSE_PUBLIC_KEY'] }),
          ...(options.productUuid === undefined ? {} : { productUuid: options.productUuid })
        })
      : undefined;
  const licenses = product?.licenses;
  const authorization = product?.authorization;
  const personalHostingAdmission = async (userId: number): Promise<boolean> =>
    userId === 1 &&
    licenses !== undefined &&
    (await licenses.capability(userId)).edition === 'COMMUNITY' &&
    (await authorization?.isPersonalAdmin(userId)) === true;
  const codexCredentials =
    authorization === undefined
      ? undefined
      : new CodexCredentialService(database as MysqlServerDatabase, {
          authorization,
          now,
          projectVersion: serverVersion
        });
  const resources =
    authorization === undefined
      ? undefined
      : new ResourceAccessService(
          database as MysqlServerDatabase,
          authorization,
          now,
          codexCredentials,
          personalHostingAdmission
        );
  const environmentSecrets =
    sqliteTestDatabase === undefined
      ? new MysqlEnvironmentSecretService(
          database as MysqlServerDatabase,
          async (userId, nodeId) => {
            try {
              return await resources!.canManageNodeSecrets(userId, nodeId);
            } catch {
              return false;
            }
          },
          (userId, nodeId) => resources!.canUseNode(userId, nodeId),
          (userId) => authorization!.managedOrganizationIds(userId),
          async (userId, organizationId) =>
            (
              await authorization!.authorize(userId, 'SECRET_MANAGE', {
                ownerType: 'ORGANIZATION',
                organizationId
              })
            ).allowed,
          (userId, nodeId, workspaceId) =>
            resources!.canManageWorkspace(userId, nodeId, workspaceId),
          (userId, nodeId, workspaceId) => resources!.canUseWorkspace(userId, nodeId, workspaceId)
        )
      : new EnvironmentSecretService(sqliteTestDatabase);
  const oauth =
    authorization === undefined || licenses === undefined
      ? undefined
      : new OAuthService(database as MysqlServerDatabase, authorization, licenses, fetch, now);
  const audits =
    authorization === undefined
      ? undefined
      : new AuditService(database as MysqlServerDatabase, authorization, now);
  const skillSources =
    authorization === undefined
      ? undefined
      : new SkillSourceService(database as MysqlServerDatabase, authorization, now);
  const skillNetwork =
    authorization === undefined
      ? undefined
      : new SkillNetworkPolicy(database as MysqlServerDatabase);
  const skillFavorites =
    authorization === undefined || skillSources === undefined
      ? undefined
      : new SkillFavoriteService(
          database as MysqlServerDatabase,
          authorization,
          skillSources,
          new GithubSkillProvider(skillNetwork!.fetch, () => skillNetwork!.disabled()),
          skillCacheDirectory,
          now,
          positiveEnvironmentInteger('MAR_SKILL_CACHE_MAX_BYTES') ?? 10 * 1024 * 1024 * 1024,
          (usedBytes, maxBytes) =>
            app.log.warn({ usedBytes, maxBytes }, 'Skill cache usage exceeded 80%')
        );
  const skillArtifacts =
    skillFavorites === undefined ? undefined : new SkillArtifactService(skillCacheDirectory, now);
  const mcps =
    authorization === undefined
      ? undefined
      : new McpService(database as MysqlServerDatabase, authorization, publicHttpsFetch, now);
  const quickPrompts =
    sqliteTestDatabase === undefined
      ? new QuickPromptService(database as MysqlServerDatabase, now)
      : undefined;
  const personalInstructions =
    sqliteTestDatabase === undefined
      ? new PersonalInstructionService(database as MysqlServerDatabase, now)
      : undefined;
  if (sqliteTestDatabase === undefined) {
    const personalGit = new PersonalGitService(database as MysqlServerDatabase);
    nodeControl.setPersonalGitService(personalGit);
    registerPersonalGitRoutes({ app, database, service: personalGit, publicOrigin, databaseError });
  }
  const marAgentModels =
    sqliteTestDatabase === undefined
      ? new MarAgentModelService(
          database as MysqlServerDatabase,
          now,
          undefined,
          resources,
          codexCredentials,
          personalHostingAdmission
        )
      : undefined;
  const imageGeneration =
    codexCredentials === undefined || sqliteTestDatabase !== undefined
      ? undefined
      : new ImageGenerationConfigurationService(
          database as MysqlServerDatabase,
          codexCredentials,
          now,
          resources
        );
  const modelUsage =
    mysqlPool === undefined
      ? undefined
      : new ModelUsageStore(
          mysqlPool,
          new ModelUsageGrants(loadOrCreateRuntimeCredentialHmacKey(dataDirectory), now),
          now
        );
  let modelUsageCleanupTimer: NodeJS.Timeout | undefined;
  if (modelUsage !== undefined) {
    nodeControl.setModelUsageService(modelUsage);
    registerModelUsageRoutes({ app, database, usage: new ModelUsageQueryService(mysqlPool!, now) });
    const cleanupUsage = () =>
      modelUsage.cleanup().catch(() => app.log.warn('MODEL_USAGE_CLEANUP_FAILED'));
    app.addHook('onReady', cleanupUsage);
    modelUsageCleanupTimer = setInterval(() => {
      void cleanupUsage();
    }, 3_600_000);
    modelUsageCleanupTimer.unref();
  }
  const runtimeCredentials =
    codexCredentials === undefined || marAgentModels === undefined
      ? undefined
      : new RuntimeCredentialService({
          resolveCredential: (credentialId, reason) =>
            codexCredentials.resolve(credentialId, reason),
          readModel: (modelId) => marAgentModels.stored(modelId),
          canUseModel: (userId, modelId) => resources!.canUseModel(userId, modelId),
          canUseCredential: (userId, credentialId) =>
            codexCredentials.assertUserInScope(userId, credentialId),
          now,
          hmacKey: loadOrCreateRuntimeCredentialHmacKey(dataDirectory)
        });
  if (runtimeCredentials !== undefined) nodeControl.setRuntimeCredentialService(runtimeCredentials);
  const marAgentRuntimeModels =
    runtimeCredentials === undefined || marAgentModels === undefined
      ? undefined
      : new MarAgentRuntimeModelService({
          models: marAgentModels,
          compact: new MarAgentCompactService(database as MysqlServerDatabase, marAgentModels),
          ...(imageGeneration === undefined ? {} : { imageGeneration }),
          tickets: runtimeCredentials,
          capability: (nodeId) => nodeControl.runtimeCredentialCapability(nodeId)
        });
  const authorizeBackgroundExecution = async (
    nodeId: string,
    request: Omit<
      import('@myagentroam/protocol').ScheduledRunAuthorizeRequest,
      'taskId' | 'revision' | 'occurrenceId'
    >,
    unavailableCode: string
  ) => {
    const allowed =
      'userCanRequestNode' in database
        ? await database.userCanRequestNode(
            request.ownerUserId,
            nodeId,
            'session.message',
            { workspaceId: request.workspaceId, sessionId: request.sessionId },
            request.workspaceId
          )
        : await database.userOwnsNode(request.ownerUserId, nodeId);
    if (!allowed) throw new Error('WORKSPACE_ACCESS_DENIED');
    if (request.runner === 'mar-agent' && request.model === null) throw new Error(unavailableCode);
    const modelPayload =
      request.runner === 'mar-agent'
        ? await runtimeModelPayload({
            userId: request.ownerUserId,
            nodeId,
            workspaceId: request.workspaceId,
            sessionId: request.sessionId,
            selectedModelId: request.model!,
            ...(marAgentModels === undefined ? {} : { marAgentModels }),
            ...(marAgentRuntimeModels === undefined ? {} : { marAgentRuntimeModels })
          })
        : {};
    return {
      ...(modelUsage === undefined
        ? {}
        : { usageGrant: modelUsage.grants.issue(nodeId, request.ownerUserId, 'work') }),
      secretEnvironment: {
        ...(await environmentSecrets.resolve(request.ownerUserId, nodeId, request.workspaceId)),
        MAR_USERNAME: '',
        ...(await userCredentials?.environment({ userId: request.ownerUserId }, publicOrigin, {
          nodeId,
          workspaceId: request.workspaceId
        }))
      },
      ...(personalInstructions === undefined
        ? {}
        : { personalInstructions: await personalInstructions.get(request.ownerUserId) }),
      ...modelPayload
    };
  };
  nodeControl.setScheduleAuthorizer((nodeId, request) =>
    authorizeBackgroundExecution(nodeId, request, 'SCHEDULE_MODEL_UNAVAILABLE')
  );
  nodeControl.setRestartAuthorizer((nodeId, request) =>
    authorizeBackgroundExecution(nodeId, request, 'RESTART_MODEL_UNAVAILABLE')
  );
  const conversationTemplates =
    resources === undefined || marAgentModels === undefined
      ? undefined
      : new ConversationTemplateService(
          database as MysqlServerDatabase,
          resources,
          marAgentModels,
          now
        );
  const authorizeHostedConversation =
    conversationTemplates === undefined
      ? undefined
      : async (userId: number, nodeId: string, templateId: string): Promise<boolean> => {
          try {
            return (await conversationTemplates.assertCanUse(userId, templateId)).nodeId === nodeId;
          } catch {
            return false;
          }
        };
  if (authorizeHostedConversation !== undefined)
    nodeControl.setHostedConversationAuthorizationHandler(authorizeHostedConversation);
  const webPushTransport = options.webPushTransport ?? createWebPushTransport();
  const webPushConfiguration =
    sqliteTestDatabase === undefined
      ? new WebPushConfiguration(
          database as MysqlServerDatabase,
          loadOrCreateRuntimeCredentialHmacKey(dataDirectory),
          publicOrigin,
          () => true
        )
      : undefined;
  const webPushClients =
    sqliteTestDatabase === undefined
      ? new WebPushClients(database as MysqlServerDatabase, now)
      : undefined;
  let webPushDispatcher: WebPushDispatcher | undefined;
  const notifications =
    sqliteTestDatabase === undefined && conversationTemplates !== undefined
      ? new WorkbenchNotificationService(
          database as MysqlServerDatabase,
          (userId, message) => nodeControl.pushUserWorkbench(userId, message),
          now,
          authorizeHostedConversation,
          (userId, notification, authorize) => {
            webPushDispatcher?.enqueue(userId, notification.id, authorize);
          }
        )
      : undefined;
  if (notifications !== undefined)
    nodeControl.setNotificationHandler((nodeId, payload) => notifications.consume(nodeId, payload));
  nodeControl.setSessionGroupChangedHandler(async (change) => {
    await Promise.all([recentRuns?.reclassify(change), notifications?.reclassify(change)]);
  });
  if (webPushConfiguration !== undefined && webPushClients !== undefined) {
    registerWebPushRoutes({
      app,
      database,
      clients: webPushClients,
      configuration: webPushConfiguration,
      publicOrigin,
      now
    });
    if (notifications !== undefined) {
      webPushDispatcher = new WebPushDispatcher({
        configuration: webPushConfiguration,
        clients: webPushClients,
        online: (userId) => nodeControl.hasUserWorkbenchConnection(userId),
        resolve: (userId, id) => notifications.forPush(userId, id),
        transport: webPushTransport,
        now,
        report: (code) => {
          app.log.warn({ code }, 'Web Push operation failed');
        }
      });
    }
  }
  const hostedConversationActivity =
    sqliteTestDatabase === undefined && conversationTemplates !== undefined
      ? new HostedConversationActivityService(conversationTemplates, (userId, message) =>
          nodeControl.pushUserWorkbench(userId, message)
        )
      : undefined;
  if (hostedConversationActivity !== undefined)
    nodeControl.setHostedConversationActivityHandler((nodeId, payload) =>
      hostedConversationActivity.consume(nodeId, payload)
    );
  if (resources !== undefined)
    (database as MysqlServerDatabase).setNodeAccessResolver((userId, nodeId) =>
      resources.canUseNode(userId, nodeId)
    );
  if (resources !== undefined)
    (database as MysqlServerDatabase).setNodeRequestAccessResolver(
      (userId, nodeId, operation, data, workspaceId) =>
        resources.canRelay(userId, nodeId, operation, data, workspaceId)
    );

  if (sqliteTestDatabase === undefined) {
    app.addHook('onReady', async () => {
      await prepareMysqlDatabase(mysqlPool!);
      await (database as MysqlServerDatabase).initialize();
    });
  }
  product?.registerLicenseManagement(app, publicOrigin);

  app.addHook('onSend', async (_request, _reply, payload) => {
    traffic.record('http', 'out', payloadByteLength(payload));
    return payload;
  });
  app.addHook('onResponse', async (request, reply) => {
    traffic.record('http', 'in', numericHeader(request.headers['content-length']));
    app.log.info(
      {
        requestId: request.id,
        statusCode: reply.statusCode,
        ...logCorrelation(request.params)
      },
      'request_completed'
    );
  });

  registerAuthRoutes({
    app,
    database,
    nodeControl,
    publicOrigin,
    secureCookies,
    now,
    loginRate,
    ...(product === undefined ? {} : { productCapabilities: product.capabilities }),
    ...(notifications === undefined ? {} : { notifications })
  });

  if (notifications !== undefined)
    registerNotificationRoutes({
      app,
      database: database as MysqlServerDatabase,
      notifications,
      ...(recentRuns === undefined ? {} : { recentRuns }),
      publicOrigin
    });

  registerManagementRoutes({
    app,
    database,
    nodeControl,
    nodeUpgrades,
    ...(resources === undefined ? {} : { resources }),
    traffic,
    publicOrigin
  });

  const marctl =
    sqliteTestDatabase === undefined
      ? registerMarctlRoutes({
          app,
          userCredentials: userCredentials!,
          publicOrigin,
          listNodes: () => nodeControl.listNodes(),
          canUseNode: (userId, nodeId) => resources!.canUseNode(userId, nodeId),
          secrets: environmentSecrets,
          ...(personalInstructions === undefined ? {} : { personalInstructions }),
          ...(marAgentModels === undefined ? {} : { marAgentModels }),
          ...(marAgentRuntimeModels === undefined ? {} : { marAgentRuntimeModels }),
          ...(audits === undefined ? {} : { audits }),
          ownsWorkbenchConnection: (sessionHash, connectionId) =>
            nodeControl.ownsWorkbenchConnection(sessionHash, connectionId),
          nodeControl: {
            requestNode: (...args) => nodeControl.requestNode(...args),
            createTerminalTicket: (input) => nodeControl.createTerminalTicket(input),
            attachBrowserTerminal: (socket, ticket, user) =>
              nodeControl.attachBrowserTerminal(socket, ticket, user),
            closeTerminal: (nodeId, terminalId) => nodeControl.closeTerminal(nodeId, terminalId),
            attachWorkbench: (socket, user) => nodeControl.attachBrowserWorkbench(socket, user)
          },
          onError: databaseError
        })
      : undefined;
  registerWebSearchRoutes({
    app,
    database,
    endpoint: options.webSearchEndpoint ?? process.env['MAR_SEARXNG_URL'] ?? 'http://searxng:8080',
    ...(options.webSearchFetch ? { request: options.webSearchFetch } : {})
  });

  registerNodeRoutes({
    app,
    database,
    nodeControl,
    nodeUpgrades,
    publicOrigin,
    capabilities: SERVER_WORKBENCH_CAPABILITIES,
    secrets: environmentSecrets,
    ...(userCredentials === undefined ? {} : { userCredentials }),
    ...(marAgentModels === undefined ? {} : { marAgentModels }),
    ...(resources === undefined ? {} : { resources })
  });
  registerWorkspaceRoutes({
    app,
    database,
    nodeControl,
    publicOrigin,
    ...(resources === undefined ? {} : { resources })
  });
  const htmlPreviewOrigin = new HtmlPreviewOrigin(database as MysqlServerDatabase);
  const sessionShares =
    mysqlPool === undefined
      ? undefined
      : new SessionShares({
          store: new MysqlSessionShares(
            database as MysqlServerDatabase,
            loadOrCreateRuntimeCredentialHmacKey(dataDirectory)
          ),
          nodeControl,
          now,
          authorize: (userId, target, operation) =>
            (database as MysqlServerDatabase).userCanRequestNode(
              userId,
              target.nodeId,
              operation,
              { workspaceId: target.workspaceId, sessionId: target.sessionId },
              target.workspaceId
            ),
          invalidate: (shareId, code) => nodeControl.invalidateSessionShare(shareId, code)
        });
  if (sessionShares !== undefined) {
    const inputs = new SessionInputService({
      nodeControl,
      secrets: environmentSecrets,
      publicOrigin,
      ...(userCredentials === undefined ? {} : { userCredentials }),
      ...(personalInstructions === undefined ? {} : { personalInstructions }),
      ...(marAgentModels === undefined ? {} : { marAgentModels }),
      ...(marAgentRuntimeModels === undefined ? {} : { marAgentRuntimeModels }),
      ...(audits === undefined ? {} : { audits })
    });
    registerSessionShareRoutes({
      app,
      database,
      nodeControl,
      shares: sessionShares,
      channels: new SessionChannelService(inputs),
      profiles: {
        secrets: environmentSecrets,
        ...(marAgentModels === undefined ? {} : { models: marAgentModels })
      },
      publicOrigin,
      secureCookies
    });
  }
  registerRealtimeRoutes({
    app,
    database,
    nodeControl,
    publicOrigin,
    ...(sessionShares === undefined ? {} : { sessionShares }),
    ...(marctl === undefined
      ? {}
      : { attachMarctl: marctl.attach, attachMarctlLive: marctl.attachLive })
  });
  registerHtmlPreviewRoutes({
    app,
    database: database as MysqlServerDatabase,
    nodeControl,
    originSetting: htmlPreviewOrigin,
    ...(sessionShares === undefined ? {} : { shares: sessionShares }),
    publicOrigin,
    databaseError
  });
  registerSessionRunRoutes({
    app,
    database,
    nodeControl,
    secrets: environmentSecrets,
    ...(userCredentials === undefined ? {} : { userCredentials }),
    ...(personalInstructions === undefined ? {} : { personalInstructions }),
    ...(marAgentModels === undefined ? {} : { marAgentModels }),
    ...(marAgentRuntimeModels === undefined ? {} : { marAgentRuntimeModels }),
    ...(audits === undefined ? {} : { audits }),
    publicOrigin
  });
  registerRunControlRoutes({
    app,
    database,
    nodeControl,
    secrets: environmentSecrets,
    ...(userCredentials === undefined ? {} : { userCredentials }),
    ...(marAgentModels === undefined ? {} : { marAgentModels }),
    ...(marAgentRuntimeModels === undefined ? {} : { marAgentRuntimeModels }),
    ...(audits === undefined ? {} : { audits }),
    publicOrigin
  });
  registerEnvironmentSecretRoutes({
    app,
    database,
    secrets: environmentSecrets,
    publicOrigin
  });
  if (authorization !== undefined) {
    registerOrganizationRoutes({
      app,
      database: database as MysqlServerDatabase,
      organizations: new OrganizationService(database as MysqlServerDatabase, authorization, now),
      publicOrigin,
      nodeControl
    });
    registerEnterpriseUserRoutes({
      app,
      database: database as MysqlServerDatabase,
      users: new EnterpriseUserService(database as MysqlServerDatabase, authorization, now),
      publicOrigin,
      nodeControl
    });
  }
  if (resources !== undefined) {
    registerResourceGrantRoutes({
      app,
      database: database as MysqlServerDatabase,
      resources,
      nodeControl,
      nodeUpgrades,
      publicOrigin
    });
  }
  if (conversationTemplates !== undefined) {
    registerConversationTemplateRoutes({
      app,
      database: database as MysqlServerDatabase,
      templates: conversationTemplates,
      nodeControl,
      publicOrigin
    });
  }
  if (conversationTemplates !== undefined && marAgentModels !== undefined) {
    registerHostedConversationRoutes({
      app,
      database: database as MysqlServerDatabase,
      templates: conversationTemplates,
      models: marAgentModels,
      ...(marAgentRuntimeModels === undefined ? {} : { marAgentRuntimeModels }),
      nodeControl,
      publicOrigin
    });
  }
  if (oauth !== undefined) {
    registerOAuthRoutes({
      app,
      database: database as MysqlServerDatabase,
      oauth,
      nodeControl,
      publicOrigin,
      secureCookies,
      notifications: notifications!
    });
  }
  if (audits !== undefined) {
    registerAuditRoutes({
      app,
      database: database as MysqlServerDatabase,
      audits
    });
  }
  if (skillSources !== undefined) {
    registerSkillSourceRoutes({
      app,
      database: database as MysqlServerDatabase,
      sources: skillSources,
      discovery: new SkillDiscoveryService(skillNetwork!.fetch),
      publicOrigin
    });
  }
  if (audits !== undefined && skillNetwork !== undefined) {
    const smtp = new MailSmtpService(
      database as MysqlServerDatabase,
      loadOrCreateRuntimeCredentialHmacKey(dataDirectory)
    );
    const mailTemplates = new MailTemplateService(database as MysqlServerDatabase);
    const mailNotifications = new MailNotificationService(
      database as MysqlServerDatabase,
      smtp,
      mailTemplates
    );
    nodeControl.setMailNotifications(mailNotifications);
    if (notifications !== undefined)
      nodeControl.setNotificationChannels(
        new NotificationChannelService({
          database: database as MysqlServerDatabase,
          notifications,
          mail: mailNotifications,
          ...(webPushDispatcher === undefined ? {} : { dispatcher: webPushDispatcher }),
          now
        })
      );
    registerSystemSettingsRoutes({
      app,
      resourceInput: new MarAgentResourceInputService(database as MysqlServerDatabase),
      database: database as MysqlServerDatabase,
      audits,
      network: skillNetwork,
      smtp,
      ...(webPushConfiguration === undefined ? {} : { webPush: webPushConfiguration }),
      htmlPreviewOrigin,
      publicOrigin
    });
    registerMailRoutes({
      app,
      database: database as MysqlServerDatabase,
      smtp,
      templates: mailTemplates,
      publicOrigin
    });
  }
  if (skillFavorites !== undefined) {
    registerSkillFavoriteRoutes({
      app,
      database: database as MysqlServerDatabase,
      favorites: skillFavorites,
      publicOrigin
    });
  }
  if (skillFavorites !== undefined && skillArtifacts !== undefined) {
    registerSkillTargetRoutes({
      app,
      database: database as MysqlServerDatabase,
      nodeControl,
      ...(resources === undefined ? {} : { resources }),
      favorites: skillFavorites,
      artifacts: skillArtifacts,
      publicOrigin
    });
  }
  if (mcps !== undefined) {
    registerMcpRoutes({
      app,
      database: database as MysqlServerDatabase,
      service: mcps,
      nodeControl,
      secrets: environmentSecrets,
      ...(resources === undefined ? {} : { resources }),
      ...(publicOrigin === undefined ? {} : { publicOrigin })
    });
    app.addHook('onReady', async () => mcps.ensureOfficialSource());
  }
  if (quickPrompts !== undefined)
    registerQuickPromptRoutes({
      app,
      database: database as MysqlServerDatabase,
      prompts: quickPrompts,
      publicOrigin
    });
  if (personalInstructions !== undefined)
    registerPersonalInstructionRoutes({
      app,
      database: database as MysqlServerDatabase,
      instructions: personalInstructions,
      publicOrigin
    });
  if (marAgentModels !== undefined && marAgentRuntimeModels !== undefined)
    registerMarAgentModelRoutes({
      app,
      database: database as MysqlServerDatabase,
      models: marAgentModels,
      runtimeModels: marAgentRuntimeModels,
      ...(imageGeneration === undefined ? {} : { imageGeneration }),
      nodeControl,
      ...(publicOrigin === undefined ? {} : { publicOrigin })
    });
  if (
    marAgentModels !== undefined &&
    marAgentRuntimeModels !== undefined &&
    resources !== undefined
  )
    registerPromptCompletionRoutes({
      app,
      database: database as MysqlServerDatabase,
      databaseError,
      models: marAgentModels,
      runtimeModels: marAgentRuntimeModels,
      resources,
      nodeControl,
      ...(publicOrigin === undefined ? {} : { publicOrigin })
    });
  if (codexCredentials !== undefined && marAgentModels !== undefined)
    registerCodexCredentialRoutes({
      app,
      database: database as MysqlServerDatabase,
      credentials: codexCredentials,
      nodeControl,
      models: marAgentModels,
      ...(publicOrigin === undefined ? {} : { publicOrigin })
    });
  let auditCleanupTimer: NodeJS.Timeout | undefined;
  let codexCredentialMaintenanceTimer: NodeJS.Timeout | undefined;
  if (codexCredentials !== undefined) {
    const observeMaintenance = (
      operation: ReturnType<CodexCredentialService['maintain']>
    ): void => {
      void operation
        .then((result) => {
          if (result.failed > 0)
            app.log.warn(
              {
                errorCode: 'CODEX_CREDENTIAL_BACKGROUND_CHECK_FAILED',
                attempted: result.attempted,
                deferred: result.deferred,
                failed: result.failed
              },
              'codex_credential_background_check_failed'
            );
        })
        .catch(() => {
          app.log.error(
            { errorCode: 'CODEX_CREDENTIAL_MAINTENANCE_FAILED' },
            'codex_credential_maintenance_failed'
          );
        });
    };
    app.addHook('onReady', async () => {
      observeMaintenance(codexCredentials.maintain('STARTUP'));
      codexCredentialMaintenanceTimer = setInterval(
        () => observeMaintenance(codexCredentials.maintain('EXPIRING')),
        CODEX_CREDENTIAL_MAINTENANCE_INTERVAL_MS
      );
      codexCredentialMaintenanceTimer.unref();
    });
  }
  if (audits !== undefined) {
    app.addHook('onReady', async () => {
      await audits.cleanupBatch();
      auditCleanupTimer = setInterval(
        () => {
          void audits.cleanupBatch().catch(() => {
            app.log.error({ errorCode: 'AUDIT_CLEANUP_FAILED' }, 'audit_cleanup_failed');
          });
        },
        60 * 60 * 1000
      );
      auditCleanupTimer.unref();
    });
  }
  let skillCacheCleanupTimer: NodeJS.Timeout | undefined;
  let skillCleanupStopped = false;
  let skillCleanupInFlight: Promise<number> | undefined;
  function startSkillCleanup(): Promise<number> | undefined {
    if (skillCleanupStopped || skillCleanupInFlight !== undefined || skillFavorites === undefined)
      return undefined;
    const operation = skillFavorites.cleanupCache().finally(() => {
      if (skillCleanupInFlight === operation) skillCleanupInFlight = undefined;
    });
    skillCleanupInFlight = operation;
    return operation;
  }
  function stopSkillCleanup(): void {
    skillCleanupStopped = true;
    if (skillCacheCleanupTimer !== undefined) {
      clearInterval(skillCacheCleanupTimer);
      skillCacheCleanupTimer = undefined;
    }
  }
  if (skillFavorites !== undefined) {
    app.addHook('onReady', async () => {
      await startSkillCleanup();
      if (skillCleanupStopped) return;
      skillCacheCleanupTimer = setInterval(
        () => {
          void startSkillCleanup()?.catch(() => {
            app.log.error(
              { errorCode: 'SKILL_CACHE_CLEANUP_FAILED' },
              'skill_cache_cleanup_failed'
            );
          });
        },
        60 * 60 * 1000
      );
      skillCacheCleanupTimer.unref();
    });
  }
  let shutdownPromise: Promise<void> | undefined;
  app.decorate('shutdown', () => {
    shutdownPromise ??= (async () => {
      // Fastify waits for upgraded WebSocket connections before its `onClose`
      // hook. Close Node sockets and all HTTP/SSE clients before asking
      // Fastify to stop accepting connections.
      nodeControl.close();
      app.server.closeAllConnections?.();
      await app.close();
    })();
    return shutdownPromise;
  });

  // Fastify waits for upgraded WebSocket connections before its `onClose`
  // hook. Close Node sockets in `preClose` so SIGTERM cannot deadlock behind
  // a still-connected Node, then release the database only after the listener ends.
  app.addHook('preClose', async () => {
    stopSkillCleanup();
    webPushDispatcher?.close();
    nodeControl.close();
  });
  app.addHook('onClose', async () => {
    stopSkillCleanup();
    webPushDispatcher?.close();
    traffic.close();
    recentRuns?.dispose();
    if (modelUsageCleanupTimer !== undefined) clearInterval(modelUsageCleanupTimer);
    if (auditCleanupTimer !== undefined) clearInterval(auditCleanupTimer);
    if (codexCredentialMaintenanceTimer !== undefined)
      clearInterval(codexCredentialMaintenanceTimer);
    // Startup or the interval owns failure reporting; draining only preserves dependency order.
    await skillCleanupInFlight?.catch(() => undefined);
    // Keep notification rechecks and late subscription expiry ahead of pool release.
    await webPushDispatcher?.flush();
    await database.close();
  });
  return app;
}

function positiveEnvironmentInteger(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined || !/^[1-9][0-9]*$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function numericHeader(value: unknown): number {
  const normalized = Array.isArray(value) ? value[0] : value;
  if (typeof normalized === 'number') return normalized;
  if (typeof normalized !== 'string' || !/^\d+$/u.test(normalized)) return 0;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function payloadByteLength(value: unknown): number {
  if (typeof value === 'string') return Buffer.byteLength(value);
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value.byteLength;
  return 0;
}
