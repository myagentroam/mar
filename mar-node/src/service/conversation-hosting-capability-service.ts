import type { ConversationHostingCapability, NodeCapabilities } from '@myagentroam/protocol';
import {
  LINUX_BUBBLEWRAP_SANDBOX_POLICY_VERSION,
  probeBubblewrapSandbox
} from '@myagentroam/agent/sandbox/linux';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NodeConfig } from '../config.js';
import { safeErrorCode } from '../util/safe-error.js';
import { hostedConversationSandboxProfile } from './hosted-conversation-sandbox-profile.js';

const CONVERSATION_HOSTING_API_VERSION = 1;

export interface ConversationHostingProbeResult {
  readonly available: boolean;
  readonly version?: string;
  readonly reasonCode?: string;
}

export type ConversationHostingProbe = () => Promise<ConversationHostingProbeResult>;

/** Runs the same bounded Bubblewrap policy used by hosted local processes. */
export async function probeBubblewrap(): Promise<ConversationHostingProbeResult> {
  const root = await mkdtemp(join(tmpdir(), 'mar-node-bwrap-probe-')).catch(() => undefined);
  if (root === undefined) return { available: false, reasonCode: 'SANDBOX_UNAVAILABLE' };
  const workspaceDirectory = join(root, 'workspace');
  const inboxDirectory = join(root, 'inbox');
  const outputDirectory = join(root, 'output');
  const temporaryDirectory = join(root, 'tmp');
  try {
    await Promise.all(
      [workspaceDirectory, inboxDirectory, outputDirectory, temporaryDirectory].map((path) =>
        mkdir(path, { mode: 0o700 })
      )
    );
    await Promise.all(
      ['inbox', 'output'].map((name) =>
        mkdir(join(workspaceDirectory, name), { recursive: true, mode: 0o700 })
      )
    );
    const result = await probeBubblewrapSandbox({
      profile: hostedConversationSandboxProfile({
        workspaceDirectory,
        sourceWorkspacePath: '/home/mar-sandbox-probe/workspace',
        inboxDirectory,
        outputDirectory,
        temporaryDirectory,
        networkMode: 'NONE'
      }),
      cwd: workspaceDirectory
    });
    return { available: true, version: result.version };
  } catch {
    return { available: false, reasonCode: 'SANDBOX_UNAVAILABLE' };
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function conversationHostingCapability(
  capabilities: NodeCapabilities,
  config: NodeConfig | undefined,
  storageReady: boolean,
  storageFailureCode: string | undefined,
  probe: ConversationHostingProbe = probeBubblewrap,
  capacity: ConversationHostingCapability['capacity'] = 'AVAILABLE'
): Promise<ConversationHostingCapability> {
  if (capabilities.platform !== 'linux' || config?.conversationHosting?.enabled !== true) {
    return disabledCapability();
  }
  if (!storageReady) {
    return unavailableCapability(storageFailureCode ?? 'CONVERSATION_HOSTING_STORAGE_UNAVAILABLE');
  }
  if (capabilities.marAgent?.available !== true) return unavailableCapability('RUNNER_UNAVAILABLE');
  let sandbox: ConversationHostingProbeResult;
  try {
    sandbox = await probe();
  } catch (error) {
    return unavailableCapability(safeErrorCode(error, 'SANDBOX_UNAVAILABLE'));
  }
  if (!sandbox.available) return unavailableCapability(sandbox.reasonCode ?? 'SANDBOX_UNAVAILABLE');
  return {
    state: 'AVAILABLE',
    apiVersion: CONVERSATION_HOSTING_API_VERSION,
    sandboxBackend: 'BUBBLEWRAP',
    sandboxPolicyVersion: LINUX_BUBBLEWRAP_SANDBOX_POLICY_VERSION,
    acceptsNewConversations: capacity !== 'FULL',
    supportsExistingConversations: true,
    capacity
  };
}

function disabledCapability(): ConversationHostingCapability {
  return {
    state: 'DISABLED',
    apiVersion: CONVERSATION_HOSTING_API_VERSION,
    acceptsNewConversations: false,
    supportsExistingConversations: false,
    capacity: 'AVAILABLE'
  };
}

function unavailableCapability(reasonCode: string): ConversationHostingCapability {
  return {
    state: 'UNAVAILABLE',
    apiVersion: CONVERSATION_HOSTING_API_VERSION,
    acceptsNewConversations: false,
    supportsExistingConversations: false,
    capacity: 'AVAILABLE',
    reasonCode
  };
}
