import {
  LINUX_BUBBLEWRAP_SANDBOX_POLICY_VERSION,
  type BubblewrapSandboxProfile,
  type LinuxSandboxMount
} from '@myagentroam/agent/sandbox/linux';
import { AgentError } from '@myagentroam/agent';
import { posix } from 'node:path';
import type { HostedConversationProcessExecutorInput } from './hosted-conversation-node-service.js';

/** Compiles Node-owned hosted-conversation directories into the generic Agent sandbox profile. */
export function hostedConversationSandboxProfile(
  input: HostedConversationProcessExecutorInput
): BubblewrapSandboxProfile {
  if (
    (input.generatedImagesDirectory === undefined) !==
    (input.generatedImagesLogicalPath === undefined)
  )
    throw new AgentError('SANDBOX_POLICY_INVALID', 'Sandbox policy is invalid.');

  const mounts: LinuxSandboxMount[] = [
    {
      source: input.workspaceDirectory,
      destination: '/workspace',
      access: 'READ_ONLY'
    },
    {
      source: input.inboxDirectory,
      destination: '/workspace/inbox',
      access: 'READ_WRITE'
    },
    {
      source: input.outputDirectory,
      destination: '/workspace/output',
      access: 'READ_WRITE'
    }
  ];

  if (
    input.generatedImagesDirectory !== undefined &&
    input.generatedImagesLogicalPath !== undefined
  )
    mounts.splice(1, 0, {
      source: input.generatedImagesDirectory,
      destination: input.generatedImagesLogicalPath,
      access: 'READ_ONLY'
    });

  if (input.sourceWorkspacePath !== undefined)
    mounts.splice(
      1,
      0,
      {
        source: input.workspaceDirectory,
        destination: input.sourceWorkspacePath,
        access: 'READ_ONLY'
      },
      {
        source: input.inboxDirectory,
        destination: posix.join(input.sourceWorkspacePath, 'inbox'),
        access: 'READ_WRITE'
      },
      {
        source: input.outputDirectory,
        destination: posix.join(input.sourceWorkspacePath, 'output'),
        access: 'READ_WRITE'
      }
    );

  return {
    policyVersion: LINUX_BUBBLEWRAP_SANDBOX_POLICY_VERSION,
    networkMode: input.networkMode,
    mounts,
    temporaryDirectory: {
      kind: 'MOUNT',
      source: input.temporaryDirectory
    },
    workingDirectory: { kind: 'REQUEST' }
  };
}
