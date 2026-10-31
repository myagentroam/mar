import type { MarctlUserCredentials } from './marctl-user-credentials.js';
import type { PersonalInstructionReader, ProcessSecretResolver } from './session-run-contracts.js';
import type { PersonalGitService } from './personal-git-service.js';
import { prepareGitExecutionContext } from './git-execution-forwarding.js';
import { runtimeModelPayload } from './run-model-payload.js';

/** Shared preparation for manual and background inputs; authorization stays with the caller. */
export async function prepareSessionExecutionContext(input: {
  readonly user: {
    readonly userId: number;
    readonly username?: string;
    readonly sessionHash?: string;
    readonly scheduled?: boolean;
    readonly channel?: boolean;
    readonly marctlExpiresAt?: number;
  };
  readonly nodeId: string;
  readonly workspaceId: string | undefined;
  readonly serverUrl: string | undefined;
  readonly credentials: MarctlUserCredentials | undefined;
  readonly instructions: PersonalInstructionReader | undefined;
  readonly secrets: ProcessSecretResolver;
  readonly git?: Pick<PersonalGitService, 'getRuntime'>;
  readonly model?: Omit<
    Parameters<typeof runtimeModelPayload>[0],
    'userId' | 'nodeId' | 'workspaceId'
  >;
}) {
  return {
    secretEnvironment: {
      ...(await input.secrets.resolve(input.user.userId, input.nodeId, input.workspaceId)),
      MAR_USERNAME: input.user.username ?? '',
      ...(await input.credentials?.environment(
        input.user,
        input.serverUrl,
        input.workspaceId === undefined
          ? undefined
          : {
              nodeId: input.nodeId,
              workspaceId: input.workspaceId
            },
        { type: 'delegation' },
        input.user.marctlExpiresAt
      ))
    },
    ...(input.instructions === undefined
      ? {}
      : { personalInstructions: await input.instructions.get(input.user.userId) }),
    ...(input.git === undefined
      ? {}
      : await prepareGitExecutionContext(input.git, input.user.userId)),
    ...(input.model === undefined
      ? {}
      : await runtimeModelPayload({
          ...input.model,
          userId: input.user.userId,
          nodeId: input.nodeId,
          workspaceId: input.workspaceId as string
        }))
  };
}
