import { composeServerCatalog } from './server-catalog.js';
import { composeServerAccess } from './server-access.js';
import { composeServerModels } from './server-models.js';
import { ServerMaintenance } from './server-maintenance.js';
import { composeServerNotifications } from './server-notifications.js';
import { ModelUsageQueryService } from '@myagentroam/server-core/model-usage-query';
import { ModelUsageGrants } from '@myagentroam/server-core/model-usage-grant';
import { ModelUsageStore } from '@myagentroam/server-core/model-usage-store';
import { registerModelUsageRoutes } from '@myagentroam/server-core/model-usage-routes';
import serverPackage from '../../package.json' with { type: 'json' };
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { serverWorkbenchCapabilities } from '@myagentroam/server-core/runner-capabilities';
import { createNodeControl } from './node-control-factory.js';
import type { NodeControl } from '../node-control.js';
import type { NodeRequestAuthorization } from '@myagentroam/server-core/node-access-contracts';
import { registerAuthRoutes } from '../route/auth-routes.js';
import { registerManagementRoutes } from '../route/management-routes.js';
import { registerRealtimeRoutes } from '../route/realtime-routes.js';
import { registerNodeRoutes } from '../route/node-routes.js';
import { registerNodeRegistrationRoute } from '@myagentroam/server-core/node-registration-route';
import { registerWorkspaceRoutes } from '../route/workspace-routes.js';
import { registerSessionRunRoutes } from '../route/session-run-routes.js';
import { runtimeModelPayload } from '@myagentroam/server-core/run-model-payload';
import { registerRunControlRoutes } from '../route/run-control-routes.js';
import { registerEnvironmentSecretRoutes } from '../route/environment-secret-routes.js';
import { prepareMysqlDatabase } from '../mysql/connection.js';
import type { MysqlServerDatabase } from '../mysql/server-database.js';
import type { Pool } from 'mysql2/promise';
import { MysqlEnvironmentSecretService } from '../mysql/environment-secret-service.js';
import { OrganizationService } from '../rbac/organization-service.js';
import { registerOrganizationRoutes } from '../route/organization-routes.js';
import { EnterpriseUserService } from '../rbac/enterprise-user-service.js';
import { registerEnterpriseUserRoutes } from '../route/enterprise-user-routes.js';
import { ResourceGrantService } from '../rbac/resource-grant-service.js';
import { registerResourceGrantRoutes } from '../route/resource-grant-routes.js';
import { OAuthService } from '../oauth/oauth-service.js';
import { registerOAuthRoutes } from '../route/oauth-routes.js';
import { AuditService } from '../audit/audit-service.js';
import { NodeUpgradeService } from '@myagentroam/server-core/node-upgrade-service';
import { registerAuditRoutes } from '../route/audit-routes.js';
import { SkillDiscoveryService } from '../skill/skill-discovery-service.js';
import { registerSkillSourceRoutes } from '../route/skill-source-routes.js';
import { registerSkillFavoriteRoutes } from '../route/skill-favorite-routes.js';
import { registerSkillTargetRoutes } from '../route/skill-target-routes.js';
import { registerSystemSettingsRoutes } from '../route/system-settings-routes.js';
import { MailSmtpService } from '@myagentroam/server-core/mail-smtp-service';
import type { WebPushTransport } from '@myagentroam/server-core/web-push-dispatcher';
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
import { registerMcpRoutes } from '../route/mcp-routes.js';
import { registerQuickPromptRoutes } from '../route/quick-prompt-routes.js';
import { QuickPromptService } from '../service/quick-prompt-service.js';
import { registerPersonalInstructionRoutes } from '../route/personal-instruction-routes.js';
import { PersonalInstructionService } from '../service/personal-instruction-service.js';
import { PersonalGitService } from '@myagentroam/server-core/personal-git-service';
import { GitExecutionForwarding } from '@myagentroam/server-core/git-execution-forwarding';
import { registerPersonalGitRoutes } from '@myagentroam/server-core/personal-git-routes';
import { MarAgentResourceInputService } from '@myagentroam/server-core/mar-agent-resource-input-service';
import { loadOrCreateRuntimeCredentialHmacKey } from '@myagentroam/server-core/runtime-credential-service';
import { registerMarAgentModelRoutes } from '../route/mar-agent-model-routes.js';
import { registerPromptCompletionRoutes } from '@myagentroam/server-core/prompt-completion-routes';
import { registerCodexCredentialRoutes } from '../route/codex-credential-routes.js';
import { RecentRunService } from '@myagentroam/server-core/recent-run-service';
import { databaseError, type LoginRateRecord } from '../util/http-request.js';
import { createServerHttp } from './server-http.js';
import { registerWebSearchRoutes } from '../route/web-search-routes.js';
import { ConversationTemplateService } from '../service/conversation-template-service.js';
import { registerConversationTemplateRoutes } from '../route/conversation-template-routes.js';
import { registerHostedConversationRoutes } from '../route/hosted-conversation-routes.js';
import { HostedConversationActivityService } from '../service/hosted-conversation-activity-service.js';
const serverVersion = typeof serverPackage.version === 'string' ? serverPackage.version : 'unknown';
const SERVER_WORKBENCH_CAPABILITIES = serverWorkbenchCapabilities(serverVersion);
// HTTP paths are request diagnostics, never business audit actions.
export function auditedAction(_method: string, _route: string): undefined {
  return undefined;
}
export interface ServerAppOptions {
  readonly webRoot?: string;
  readonly dataDirectory?: string;
  readonly databaseUrl?: string;
  readonly secureCookies?: boolean;
  readonly publicOrigin?: string;
  readonly logger?: boolean;
  readonly now?: () => number;
  readonly productUuid?: string | null;
  readonly nodeUpgrades?: Pick<NodeUpgradeService, 'availability'>;
  readonly webSearchEndpoint?: string;
  readonly webSearchFetch?: typeof fetch;
  readonly webPushTransport?: WebPushTransport;
}
export interface ServerApplication extends FastifyInstance {
  shutdown(): Promise<void>;
}
export interface ServerApplicationStorage {
  readonly database: MysqlServerDatabase;
  readonly pool: Pool;
}
/** Compose the complete MySQL-backed Server product. */
export async function composeServerApplication(
  options: ServerAppOptions,
  storage: ServerApplicationStorage
): Promise<{ readonly app: ServerApplication }> {
  const database = storage.database;
  const mysqlPool = storage.pool;
  const now = options.now ?? Date.now;
  const dataDirectory = resolve(options.dataDirectory ?? process.env['MAR_DATA_DIR'] ?? './data');
  const skillCacheDirectory = resolve(dataDirectory, 'skills');
  // Issue HTTPS-only cookies by default; callers must explicitly pass false for local plaintext development.
  const secureCookies = options.secureCookies ?? true;
  const publicOrigin = options.publicOrigin ?? process.env['MAR_PUBLIC_ORIGIN'];
  const userCredentials = new MarctlUserCredentials(mysqlPool, now);
  const loginRate = new Map<string, LoginRateRecord>();
  const { app: httpApp, traffic } = createServerHttp({
    dataDirectory,
    ...(options.webRoot === undefined ? {} : { webRoot: options.webRoot }),
    ...(options.logger === undefined ? {} : { logger: options.logger })
  });
  const app = httpApp as unknown as ServerApplication;
  let constructedNodeControl: NodeControl | undefined;
  let constructedRecentRuns: RecentRunService | undefined;
  let constructedMaintenance: ServerMaintenance | undefined;
  let constructedPush:
    Awaited<ReturnType<typeof composeServerNotifications>>['dispatcher'] | undefined;
  try {
    const nodeUpgrades = options.nodeUpgrades ?? new NodeUpgradeService(serverVersion);
    const {
      product,
      licenses,
      authorization,
      codexCredentials,
      resources,
      directory,
      mutations,
      personalHostingAdmission
    } = composeServerAccess({
      database,
      now,
      chatgptNodeRequest: (actor, nodeId, operation, data) =>
        nodeControl.requestNode(
          nodeId,
          operation,
          data,
          { userId: actor.userId, sessionHash: actor.sessionFingerprint },
          45_000
        ),
      projectVersion: serverVersion,
      ...(process.env['MAR_LICENSE_PUBLIC_KEY'] === undefined
        ? {}
        : { publicKey: process.env['MAR_LICENSE_PUBLIC_KEY'] }),
      ...(options.productUuid === undefined ? {} : { productUuid: options.productUuid })
    });
    const authorizeNodeRequest: NodeRequestAuthorization = resources.canRelay.bind(resources);
    const personalGit = new PersonalGitService(database);
    const modelUsage = new ModelUsageStore(
      mysqlPool,
      new ModelUsageGrants(loadOrCreateRuntimeCredentialHmacKey(dataDirectory), now),
      now
    );
    let mailNotifications: MailNotificationService;
    let notificationChannels: NotificationChannelService;
    const nodeControl = createNodeControl(
      database,
      authorizeNodeRequest,
      {
        authorizeHostedConversation: (userId, nodeId, templateId) =>
          authorizeHostedConversation(userId, nodeId, templateId),
        modelUsage,
        mailNotifications: { send: (...args) => mailNotifications.send(...args) },
        notificationChannels: { send: (...args) => notificationChannels.send(...args) },
        scheduleAuthorizer: (nodeId, request) =>
          authorizeBackgroundExecution(nodeId, request, 'SCHEDULE_MODEL_UNAVAILABLE'),
        restartAuthorizer: (nodeId, request) =>
          authorizeBackgroundExecution(nodeId, request, 'RESTART_MODEL_UNAVAILABLE'),
        notification: (nodeId, payload) => notifications.consume(nodeId, payload),
        runtimeCredentials: {
          activateNodeConnection: (nodeId) => runtimeCredentials.activateNodeConnection(nodeId),
          deactivateNodeConnection: (nodeId) => runtimeCredentials.deactivateNodeConnection(nodeId),
          resolve: (nodeId, payload) => runtimeCredentials.resolve(nodeId, payload)
        },
        hostedConversationActivity: (nodeId, payload) =>
          hostedConversationActivity.consume(nodeId, payload),
        recentRuns: (nodeId, payload) => recentRuns.consume(nodeId, payload),
        recentRunDisconnected: (nodeId) => recentRuns.disconnected(nodeId),
        sessionGroupChanged: async (change) => {
          await Promise.all([recentRuns.reclassify(change), notifications.reclassify(change)]);
        }
      },
      { usageGrants: modelUsage.grants, gitForwarding: new GitExecutionForwarding(personalGit) },
      (event, fields) => app.log.info({ event, ...fields }),
      traffic
    );
    constructedNodeControl = nodeControl;
    const recentRuns = new RecentRunService(
      database,
      authorizeNodeRequest,
      (userId, message) => nodeControl.pushUserWorkbench(userId, message),
      now
    );
    constructedRecentRuns = recentRuns;
    const environmentSecrets = new MysqlEnvironmentSecretService(database, {
      canManageNode: async (userId, nodeId) => {
        try {
          return await resources.canManageNodeSecrets(userId, nodeId);
        } catch {
          return false;
        }
      },
      canUseNode: (userId, nodeId) => resources.canUseNode(userId, nodeId),
      managedOrganizationIds: (userId) => authorization.managedOrganizationIds(userId),
      canManageOrganization: async (userId, organizationId) =>
        (
          await authorization.authorize(userId, 'SECRET_MANAGE', {
            ownerType: 'ORGANIZATION',
            organizationId
          })
        ).allowed,
      canManageWorkspace: (userId, nodeId, workspaceId) =>
        resources.canManageWorkspace(userId, nodeId, workspaceId),
      canUseWorkspace: (userId, nodeId, workspaceId) =>
        resources.canUseWorkspace(userId, nodeId, workspaceId)
    });
    const oauth = new OAuthService(database, authorization, licenses, fetch, now);
    const audits = new AuditService(database, authorization, now);
    const { skillSources, skillNetwork, skillFavorites, skillArtifacts, mcps } =
      composeServerCatalog({
        database,
        authorization,
        cacheDirectory: skillCacheDirectory,
        cacheMaxBytes:
          positiveEnvironmentInteger('MAR_SKILL_CACHE_MAX_BYTES') ?? 10 * 1024 * 1024 * 1024,
        warnCacheUsage: (usedBytes, maxBytes) =>
          app.log.warn({ usedBytes, maxBytes }, 'Skill cache usage exceeded 80%'),
        now
      });
    const quickPrompts = new QuickPromptService(database, now);
    const personalInstructions = new PersonalInstructionService(database, now);
    {
      registerPersonalGitRoutes({
        app,
        database,
        service: personalGit,
        publicOrigin,
        databaseError
      });
    }
    const {
      models: marAgentModels,
      imageGeneration,
      runtimeCredentials,
      runtimeModels: marAgentRuntimeModels
    } = composeServerModels({
      database,
      credentials: codexCredentials,
      resources,
      personalHostingAdmission,
      nodeCapability: (nodeId) => nodeControl.runtimeCredentialCapability(nodeId),
      dataDirectory,
      now
    });
    registerModelUsageRoutes({ app, database, usage: new ModelUsageQueryService(mysqlPool, now) });
    const maintenance = new ServerMaintenance(
      app,
      modelUsage,
      codexCredentials,
      audits,
      skillFavorites
    );
    constructedMaintenance = maintenance;
    const authorizeBackgroundExecution = async (
      nodeId: string,
      request: Omit<
        import('@myagentroam/protocol').ScheduledRunAuthorizeRequest,
        'taskId' | 'revision' | 'occurrenceId'
      >,
      unavailableCode: string
    ) => {
      const allowed = await authorizeNodeRequest(
        request.ownerUserId,
        nodeId,
        'session.message',
        { workspaceId: request.workspaceId, sessionId: request.sessionId },
        request.workspaceId
      );
      if (!allowed) throw new Error('WORKSPACE_ACCESS_DENIED');
      if (request.runner === 'mar-agent' && request.model === null)
        throw new Error(unavailableCode);
      const modelPayload =
        request.runner === 'mar-agent'
          ? await runtimeModelPayload({
              userId: request.ownerUserId,
              nodeId,
              workspaceId: request.workspaceId,
              sessionId: request.sessionId,
              selectedModelId: request.model!,
              marAgentModels,
              marAgentRuntimeModels
            })
          : {};
      return {
        usageGrant: modelUsage.grants.issue(nodeId, request.ownerUserId, 'work'),
        secretEnvironment: {
          ...(await environmentSecrets.resolve(request.ownerUserId, nodeId, request.workspaceId)),
          MAR_USERNAME: '',
          ...(await userCredentials.environment({ userId: request.ownerUserId }, publicOrigin, {
            nodeId,
            workspaceId: request.workspaceId
          }))
        },
        personalInstructions: await personalInstructions.get(request.ownerUserId),
        ...modelPayload
      };
    };
    const conversationTemplates = new ConversationTemplateService(
      database,
      resources,
      marAgentModels,
      now
    );
    const authorizeHostedConversation = async (
      userId: number,
      nodeId: string,
      templateId: string
    ): Promise<boolean> => {
      try {
        return (await conversationTemplates.assertCanUse(userId, templateId)).nodeId === nodeId;
      } catch {
        return false;
      }
    };
    const {
      notifications,
      configuration: webPushConfiguration,
      dispatcher: webPushDispatcher
    } = composeServerNotifications({
      app,
      database,
      nodeControl,
      recentRuns,
      authorize: authorizeNodeRequest,
      authorizeHosted: authorizeHostedConversation,
      dataDirectory,
      publicOrigin,
      now,
      transport: options.webPushTransport
    });
    constructedPush = webPushDispatcher;
    const hostedConversationActivity = new HostedConversationActivityService(
      conversationTemplates,
      (userId, message) => nodeControl.pushUserWorkbench(userId, message)
    );
    {
      app.addHook('onReady', async () => {
        await prepareMysqlDatabase(mysqlPool);
        await database.initialize();
      });
    }
    maintenance.registerModelUsage();
    product.registerLicenseManagement(app, publicOrigin);
    registerAuthRoutes({
      app,
      store: database,
      audit: { record: (event) => database.audit(event) },
      nodeControl,
      publicOrigin,
      secureCookies,
      now,
      loginRate,
      productCapabilities: product.capabilities,
      notifications
    });
    registerManagementRoutes({
      app,
      database,
      nodeControl,
      nodeUpgrades,
      resources,
      directory,
      users: {
        list: async (query) => {
          const result = await database.listUsers(query);
          return 'users' in result ? result : { users: result };
        },
        deletionSummary: (userId) => database.userDeletionSummary(userId)
      },
      traffic,
      publicOrigin
    });
    const marctl = registerMarctlRoutes({
      app,
      userCredentials,
      publicOrigin,
      listNodes: () => nodeControl.listNodes(),
      canUseNode: (userId, nodeId) => resources.canUseNode(userId, nodeId),
      secrets: environmentSecrets,
      personalInstructions,
      marAgentModels,
      marAgentRuntimeModels,
      audits,
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
    });
    registerWebSearchRoutes({
      app,
      database,
      endpoint:
        options.webSearchEndpoint ?? process.env['MAR_SEARXNG_URL'] ?? 'http://searxng:8080',
      ...(options.webSearchFetch ? { request: options.webSearchFetch } : {})
    });
    registerNodeRegistrationRoute({
      app,
      sessions: database,
      publicOrigin,
      requireDisplayName: true,
      authorize: (userId, ownership) => resources.assertOwnershipSelection(userId, ownership),
      createToken: (userId, ttlMs, ownership, displayName) =>
        database.createNodeRegistrationToken(userId, ttlMs, ownership, displayName),
      onError: databaseError
    });
    registerNodeRoutes({
      app,
      database,
      nodeControl,
      nodeUpgrades,
      publicOrigin,
      capabilities: SERVER_WORKBENCH_CAPABILITIES,
      secrets: environmentSecrets,
      userCredentials,
      marAgentModels,
      resources,
      mutations
    });
    registerWorkspaceRoutes({
      app,
      database,
      nodeControl,
      publicOrigin,
      resources: {
        projectNodeWorkspaces: async (userId, nodeId, workspaces) => {
          await mutations.backfillNodeWorkspaces(nodeId, workspaces);
          return resources.projectNodeWorkspaces(userId, nodeId, workspaces);
        },
        resolveWorkspaceOwnership: resources.resolveWorkspaceOwnership.bind(resources),
        assertCanManageWorkspace: resources.assertCanManageWorkspace.bind(resources),
        assertCanUnregisterWorkspace: resources.assertCanUnregisterWorkspace.bind(resources),
        registerWorkspace: mutations.registerWorkspace.bind(mutations),
        unregisterWorkspace: mutations.unregisterWorkspace.bind(mutations),
        updateWorkspaceGroupName: mutations.updateWorkspaceGroupName.bind(mutations),
        updateWorkspace: mutations.updateWorkspace.bind(mutations)
      }
    });
    const htmlPreviewOrigin = new HtmlPreviewOrigin(database);
    const sessionShares = new SessionShares({
      store: new MysqlSessionShares(database, loadOrCreateRuntimeCredentialHmacKey(dataDirectory)),
      nodeControl,
      now,
      authorize: async (userId, target, operation) =>
        authorizeNodeRequest(
          userId,
          target.nodeId,
          operation,
          { workspaceId: target.workspaceId, sessionId: target.sessionId },
          target.workspaceId
        ),
      invalidate: (shareId, code) => nodeControl.invalidateSessionShare(shareId, code)
    });
    {
      const inputs = new SessionInputService({
        nodeControl,
        secrets: environmentSecrets,
        publicOrigin,
        userCredentials,
        personalInstructions,
        marAgentModels,
        marAgentRuntimeModels,
        audits
      });
      registerSessionShareRoutes({
        app,
        database,
        nodeControl,
        shares: sessionShares,
        channels: new SessionChannelService(inputs),
        profiles: {
          secrets: environmentSecrets,
          models: marAgentModels
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
      sessionShares,
      attachMarctl: marctl.attach,
      attachMarctlLive: marctl.attachLive
    });
    registerHtmlPreviewRoutes({
      app,
      database,
      nodeControl,
      originSetting: htmlPreviewOrigin,
      shares: sessionShares,
      publicOrigin,
      databaseError
    });
    registerSessionRunRoutes({
      app,
      database,
      nodeControl,
      secrets: environmentSecrets,
      userCredentials,
      personalInstructions,
      marAgentModels,
      marAgentRuntimeModels,
      audits,
      publicOrigin
    });
    registerRunControlRoutes({
      app,
      database,
      authorizeNodeRequest,
      nodeControl,
      secrets: environmentSecrets,
      userCredentials,
      marAgentModels,
      marAgentRuntimeModels,
      audits,
      publicOrigin
    });
    registerEnvironmentSecretRoutes({
      app,
      database,
      secrets: environmentSecrets,
      publicOrigin
    });
    {
      registerOrganizationRoutes({
        app,
        database,
        organizations: new OrganizationService(database, authorization, now),
        publicOrigin,
        nodeControl
      });
      registerEnterpriseUserRoutes({
        app,
        database,
        users: new EnterpriseUserService(database, authorization, now),
        publicOrigin,
        nodeControl
      });
    }
    {
      registerResourceGrantRoutes({
        app,
        database,
        directory,
        grants: new ResourceGrantService(database, authorization, codexCredentials, now),
        nodeControl,
        nodeUpgrades,
        publicOrigin
      });
    }
    {
      registerConversationTemplateRoutes({
        app,
        database,
        templates: conversationTemplates,
        nodeControl,
        publicOrigin
      });
    }
    {
      registerHostedConversationRoutes({
        app,
        database,
        templates: conversationTemplates,
        models: marAgentModels,
        marAgentRuntimeModels,
        nodeControl,
        publicOrigin
      });
    }
    {
      registerOAuthRoutes({
        app,
        database,
        oauth,
        nodeControl,
        publicOrigin,
        secureCookies,
        notifications
      });
    }
    {
      registerAuditRoutes({
        app,
        database,
        audits
      });
    }
    {
      registerSkillSourceRoutes({
        app,
        database,
        sources: skillSources,
        discovery: new SkillDiscoveryService(skillNetwork.fetch),
        publicOrigin
      });
    }
    {
      const smtp = new MailSmtpService(
        database,
        loadOrCreateRuntimeCredentialHmacKey(dataDirectory)
      );
      const mailTemplates = new MailTemplateService(database);
      mailNotifications = new MailNotificationService(
        database,
        authorizeNodeRequest,
        smtp,
        mailTemplates
      );
      notificationChannels = new NotificationChannelService({
        database,
        authorize: authorizeNodeRequest,
        notifications,
        mail: mailNotifications,
        dispatcher: webPushDispatcher,
        now
      });
      registerSystemSettingsRoutes({
        app,
        resourceInput: new MarAgentResourceInputService(database),
        database,
        audits,
        network: skillNetwork,
        smtp,
        webPush: webPushConfiguration,
        htmlPreviewOrigin,
        publicOrigin
      });
      registerMailRoutes({
        app,
        database,
        smtp,
        templates: mailTemplates,
        publicOrigin
      });
    }
    {
      registerSkillFavoriteRoutes({
        app,
        database,
        favorites: skillFavorites,
        publicOrigin
      });
    }
    {
      registerSkillTargetRoutes({
        app,
        database,
        nodeControl,
        resources,
        favorites: skillFavorites,
        artifacts: skillArtifacts,
        publicOrigin
      });
    }
    {
      registerMcpRoutes({
        app,
        database,
        service: mcps,
        nodeControl,
        secrets: environmentSecrets,
        resources,
        ...(publicOrigin === undefined ? {} : { publicOrigin })
      });
      app.addHook('onReady', async () => mcps.ensureOfficialSource());
    }
    registerQuickPromptRoutes({
      app,
      database,
      prompts: quickPrompts,
      publicOrigin
    });
    registerPersonalInstructionRoutes({
      app,
      database,
      instructions: personalInstructions,
      publicOrigin
    });
    registerMarAgentModelRoutes({
      app,
      database,
      authorizeNodeRequest,
      models: marAgentModels,
      runtimeModels: marAgentRuntimeModels,
      imageGeneration,
      nodeControl,
      ...(publicOrigin === undefined ? {} : { publicOrigin })
    });
    registerPromptCompletionRoutes({
      app,
      database,
      databaseError,
      models: marAgentModels,
      runtimeModels: marAgentRuntimeModels,
      resources,
      nodeControl,
      ...(publicOrigin === undefined ? {} : { publicOrigin })
    });
    registerCodexCredentialRoutes({
      app,
      database,
      credentials: codexCredentials,
      models: marAgentModels,
      ...(publicOrigin === undefined ? {} : { publicOrigin })
    });
    maintenance.registerRemaining();
    let shutdownPromise: Promise<void> | undefined;
    app.decorate('shutdown', () => {
      shutdownPromise ??= (async () => {
        // Fastify waits for upgraded WebSocket connections before its `onClose`
        // hook. Close Node sockets and all HTTP/SSE clients before asking
        // Fastify to stop accepting connections.
        let listenerError: unknown;
        try {
          app.server.closeAllConnections?.();
        } catch (error) {
          listenerError = error;
        }
        try {
          await app.close();
        } catch (error) {
          if (listenerError !== undefined)
            throw new AggregateError([listenerError, error], 'Failed to shut down Server', {
              cause: listenerError
            });
          throw error;
        }
        if (listenerError !== undefined) throw listenerError;
      })();
      return shutdownPromise;
    });
    // Fastify waits for upgraded WebSocket connections before its `onClose`
    // hook. Close Node sockets in `preClose` so SIGTERM cannot deadlock behind
    // a still-connected Node, then release the database only after the listener ends.
    const closeErrors: unknown[] = [];
    let admissionStopped = false;
    app.addHook('preClose', async () => {
      if (admissionStopped) return;
      admissionStopped = true;
      for (const stop of [() => maintenance.stop(), () => webPushDispatcher.close()]) {
        try {
          stop();
        } catch (error) {
          closeErrors.push(error);
        }
      }
      try {
        nodeControl.close();
      } catch (error) {
        closeErrors.push(error);
      }
    });
    app.addHook('onClose', async () => {
      const attempt = async (action: () => void | Promise<void>): Promise<void> => {
        try {
          await action();
        } catch (error) {
          closeErrors.push(error);
        }
      };
      await attempt(() => maintenance.stop());
      await attempt(() => webPushDispatcher.close());
      await attempt(() => traffic.close());
      await attempt(() => nodeControl.drainProjections());
      await attempt(() => recentRuns.dispose());
      // Failures are reported by the owning startup or interval; drain before pool release.
      await maintenance.drain();
      // Keep notification rechecks and late subscription expiry ahead of pool release.
      await attempt(async () => webPushDispatcher.flush());
      await attempt(() => database.close());
      if (closeErrors.length === 1) throw closeErrors[0];
      if (closeErrors.length > 1)
        throw new AggregateError(closeErrors, 'Failed to close Server resources', {
          cause: closeErrors[0]
        });
    });
    return { app };
  } catch (error) {
    const errors: unknown[] = [error];
    for (const cleanup of [
      () => constructedMaintenance?.stop(),
      () => constructedPush?.close(),
      () => constructedNodeControl?.close(),
      () => traffic.close(),
      () => constructedNodeControl?.drainProjections(),
      () => constructedRecentRuns?.dispose(),
      () => constructedMaintenance?.drain(),
      () => constructedPush?.flush(),
      () => app.close()
    ]) {
      try {
        await cleanup();
      } catch (cleanupError) {
        errors.push(cleanupError);
      }
    }
    if (errors.length > 1)
      throw new AggregateError(errors, 'Failed to construct Server application', { cause: error });
    throw error;
  }
}
function positiveEnvironmentInteger(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined || !/^[1-9][0-9]*$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
