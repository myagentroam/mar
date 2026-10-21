import type { NodeCapabilities } from '@myagentroam/protocol';
import type { NodeDatabase } from '../database.js';
import { hostedConversationStorePath, nodeDataDirectory, type NodeConfig } from '../config.js';
import type { NodeOperationHandler } from '../connector/node-operation-router.js';
import { HostedConversationStore } from './hosted-conversation-store.js';
import { ConversationTemplateNodeService } from './conversation-template-node-service.js';
import { HostedConversationNodeService } from './hosted-conversation-node-service.js';
import { ConversationHostingMaintenanceService } from './conversation-hosting-maintenance-service.js';
import { MarAgentHostedConversationRuntime } from '../runner/mar-agent/hosted-conversation-runtime.js';
import { BubblewrapSandboxExecutor } from '@myagentroam/agent/sandbox/linux';
import { hostedConversationSandboxProfile } from './hosted-conversation-sandbox-profile.js';
import {
  conversationHostingCapability,
  type ConversationHostingProbe
} from './conversation-hosting-capability-service.js';
import { nodeLog } from '../operational.js';
import { safeErrorCode } from '../util/safe-error.js';

interface Options {
  readonly config: () => NodeConfig | undefined;
  readonly configPath: string | undefined;
  readonly database: () => NodeDatabase | undefined;
  readonly capabilities: () => NodeCapabilities;
  readonly probe: ConversationHostingProbe;
  readonly runtime: ConstructorParameters<typeof MarAgentHostedConversationRuntime>[0];
  readonly host: Pick<
    ConstructorParameters<typeof HostedConversationNodeService>[0],
    | 'modelUsage'
    | 'nodeGeneration'
    | 'sessionWatchSlots'
    | 'emitWatchEvent'
    | 'nextWorkbenchEvent'
    | 'emitWorkbenchEvent'
    | 'readImage'
  >;
}
interface Resources {
  readonly runtime: MarAgentHostedConversationRuntime;
  readonly service: HostedConversationNodeService;
  readonly maintenance: ConversationHostingMaintenanceService;
  readonly operations: Readonly<Record<string, NodeOperationHandler>>;
}

/** Owns the hosting resource lifetime, including partial initialization and hot reconfiguration. */
export class ConversationHostingLifecycleService {
  private resources: Resources | undefined;
  private failureCode: string | undefined;
  private initializing: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private closed = false;
  constructor(private readonly options: Options) {}

  handler(operation: string): NodeOperationHandler | undefined {
    return this.resources?.operations[operation];
  }
  prepareForDisable(): (() => void) | undefined {
    return this.resources?.service.prepareForDisable() ?? (this.resources ? undefined : () => {});
  }
  initialize(): Promise<void> {
    if (this.closed) return Promise.resolve();
    const work = (this.initializing ?? Promise.resolve()).then(() => this.rebuild());
    this.initializing = work;
    return work.finally(() => {
      if (this.initializing === work) this.initializing = undefined;
    });
  }
  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    const current = this.resources;
    this.resources = undefined;
    this.closing = (async () => {
      try {
        await this.initializing;
      } finally {
        await this.release(current);
      }
    })();
    return this.closing;
  }
  private async release(resources: Resources | undefined): Promise<void> {
    if (!resources) return;
    try {
      await resources.maintenance.dispose();
    } finally {
      try {
        await resources.service.dispose();
      } finally {
        await resources.runtime.dispose().catch(() => undefined);
      }
    }
  }
  private async rebuild(): Promise<void> {
    if (this.closed) return;
    const previous = this.resources;
    this.resources = undefined;
    this.failureCode = undefined;
    await this.release(previous);
    if (this.closed) return;
    const config = this.options.config();
    const database = this.options.database();
    if (
      config?.conversationHosting?.enabled === true &&
      this.options.capabilities().platform === 'linux'
    ) {
      if (config.nodeId === undefined) {
        this.failureCode = 'NODE_UNAUTHENTICATED';
      } else {
        let runtime: MarAgentHostedConversationRuntime | undefined;
        let hostedService: HostedConversationNodeService | undefined;
        let maintenanceService: ConversationHostingMaintenanceService | undefined;
        try {
          if (database === undefined) throw new Error('NODE_DATABASE_UNAVAILABLE');
          const rootDirectory = hostedConversationStorePath(config, this.options.configPath);
          if (rootDirectory === undefined)
            throw new Error('CONVERSATION_HOSTING_STORAGE_UNAVAILABLE');
          const store = new HostedConversationStore({
            dataDirectory: nodeDataDirectory(config, this.options.configPath),
            rootDirectory,
            nodeId: config.nodeId,
            database: database
          });
          await store.initialize();
          const templateService = new ConversationTemplateNodeService({
            database: database,
            store,
            nodeId: () => this.options.config()?.nodeId ?? 'unregistered'
          });
          await templateService.recoverInterruptedPublications();
          await store.rebuildConversationIndex();
          runtime = new MarAgentHostedConversationRuntime({
            ...this.options.runtime
          });
          hostedService = new HostedConversationNodeService({
            ...this.options.host,
            database: database,
            store,
            runtime,
            nodeId: () => this.options.config()?.nodeId ?? 'unregistered',
            nodeAppVersion: () => this.options.capabilities().nodeAppVersion ?? 'unknown',
            processExecutorFactory: (input) =>
              new BubblewrapSandboxExecutor({
                profile: hostedConversationSandboxProfile(input)
              }),
            assertCanCreate: () => {
              if (maintenanceService === undefined)
                throw new Error('CONVERSATION_HOSTING_UNAVAILABLE');
              return maintenanceService.assertCanCreate();
            }
          });
          maintenanceService = new ConversationHostingMaintenanceService({
            store,
            inactiveRetentionDays: config.conversationHosting.inactiveRetentionDays ?? 60,
            isConversationInUse: (conversationId) =>
              hostedService?.isConversationInUse(conversationId) ?? true,
            beginConversationCleanup: (conversationId) =>
              hostedService?.beginConversationCleanup(conversationId),
            releaseConversation: (conversation) => {
              if (hostedService === undefined) throw new Error('CONVERSATION_HOSTING_UNAVAILABLE');
              return hostedService.releaseConversationForCleanup(conversation);
            },
            onAutomaticCleanupError: (error) =>
              nodeLog('conversation.hosting.cleanup.failed', {
                nodeId: config.nodeId,
                code: safeErrorCode(error, 'CONVERSATION_HOSTING_CLEANUP_FAILED')
              })
          });
          await maintenanceService.start();
          if (this.closed) {
            await this.release({
              runtime,
              service: hostedService,
              maintenance: maintenanceService,
              operations: {}
            });
            return;
          }
          this.resources = {
            runtime,
            service: hostedService,
            maintenance: maintenanceService,
            operations: {
              ...templateService.operations(),
              ...hostedService.operations(),
              ...maintenanceService.operations()
            }
          };
        } catch (error) {
          try {
            await maintenanceService?.dispose();
          } catch (cleanupError) {
            nodeLog('conversation.hosting.cleanup.failed', {
              nodeId: config.nodeId,
              code: safeErrorCode(cleanupError, 'CONVERSATION_HOSTING_CLEANUP_FAILED')
            });
          } finally {
            try {
              await hostedService?.dispose();
            } catch (cleanupError) {
              nodeLog('conversation.hosting.cleanup.failed', {
                nodeId: config.nodeId,
                code: safeErrorCode(cleanupError, 'CONVERSATION_HOSTING_CLEANUP_FAILED')
              });
            } finally {
              await runtime?.dispose().catch(() => undefined);
            }
          }
          if (this.closed) return;
          this.failureCode = safeErrorCode(error, 'CONVERSATION_HOSTING_RECOVERY_FAILED');
          nodeLog('conversation.hosting.initialization.failed', {
            nodeId: config.nodeId,
            code: this.failureCode
          });
        }
      }
    }
  }

  async project(capabilities: NodeCapabilities): Promise<NodeCapabilities> {
    const current = this.resources;
    let ready = current !== undefined;
    let failureCode = this.failureCode;
    let capacity: NonNullable<NodeCapabilities['conversationHosting']>['capacity'] = 'AVAILABLE';
    if (current) {
      try {
        capacity = (await current.maintenance.storageCapacity()).capacity;
      } catch (error) {
        ready = false;
        failureCode = safeErrorCode(error, 'CONVERSATION_HOSTING_STORAGE_UNAVAILABLE');
      }
    }
    const conversationHosting = await conversationHostingCapability(
      capabilities,
      this.options.config(),
      ready,
      failureCode,
      this.options.probe,
      capacity
    );
    if (current !== this.resources) return this.project(capabilities);
    return { ...capabilities, conversationHosting };
  }
}
