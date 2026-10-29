import type { MarctlUserCredentials } from './marctl-user-credentials.js';
import type { PersonalInstructionReader, ProcessSecretResolver } from './session-run-contracts.js';

/** Shared preparation for browser and CLI inputs; authorization stays with the caller. */
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
}): Promise<object> {
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
      : { personalInstructions: await input.instructions.get(input.user.userId) })
  };
}
