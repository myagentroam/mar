import { MarAgentModelService } from '../service/mar-agent-model-service.js';
import {
  MarAgentRuntimeModelService,
  MarAgentCompactService
} from '@myagentroam/server-core/mar-agent-runtime-model-service';
import { ImageGenerationConfigurationService } from '@myagentroam/server-core/image-generation-configuration-service';
import {
  RuntimeCredentialService,
  loadOrCreateRuntimeCredentialHmacKey
} from '@myagentroam/server-core/runtime-credential-service';
import type { MysqlServerDatabase } from '../mysql/server-database.js';
import type { CodexCredentialService } from '../service/codex-credential-service.js';
import type { ResourceAccessService } from '../rbac/resource-access-service.js';
import type { NodeControl } from '../node-control.js';

/** Compose model configuration and its runtime-only credential projection. */
export function composeServerModels(input: {
  readonly database: MysqlServerDatabase;
  readonly credentials: CodexCredentialService;
  readonly resources: ResourceAccessService;
  readonly personalHostingAdmission: (userId: number) => Promise<boolean>;
  readonly nodeCapability: NodeControl['runtimeCredentialCapability'];
  readonly dataDirectory: string;
  readonly now: () => number;
}) {
  const { database, credentials, resources, now } = input;
  const models = new MarAgentModelService(
    database,
    now,
    undefined,
    resources,
    credentials,
    input.personalHostingAdmission
  );
  const imageGeneration = new ImageGenerationConfigurationService(
    database,
    credentials,
    now,
    resources
  );
  const runtimeCredentials = new RuntimeCredentialService({
    resolveCredential: (credentialId, reason) => credentials.resolve(credentialId, reason),
    readModel: (modelId) => models.stored(modelId),
    canUseModel: (userId, modelId) => resources.canUseModel(userId, modelId),
    canUseCredential: (userId, credentialId) => credentials.assertUserInScope(userId, credentialId),
    now,
    hmacKey: loadOrCreateRuntimeCredentialHmacKey(input.dataDirectory)
  });
  const runtimeModels = new MarAgentRuntimeModelService({
    models,
    compact: new MarAgentCompactService(database, models),
    imageGeneration,
    tickets: runtimeCredentials,
    capability: input.nodeCapability
  });
  return { models, imageGeneration, runtimeCredentials, runtimeModels };
}
