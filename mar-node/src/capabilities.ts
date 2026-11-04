import { release, version } from 'node:os';
import nodePackage from '../package.json' with { type: 'json' };
import type { NodeCapabilities } from '@myagentroam/protocol';
import { probeClaudeCode, probeClaudeCodeAsync } from './runner/claude/claude-agent-sdk.js';
import { probeCodex, probeCodexAsync } from './runner/codex/codex-app-server.js';
import { probeOpenCode, probeOpenCodeAsync } from './opencode-runtime.js';
import { detectRuntimeCommands } from './runtime-command-detector.js';

const nodeAppVersion = typeof nodePackage.version === 'string' ? nodePackage.version : 'unknown';
const runtimeCredentialCapability = (): NonNullable<
  NodeCapabilities['marAgentRuntimeCredentials']
> => ({
  apiVersion: 1,
  websocket: true,
  serviceTiers: ['auto', 'default', 'flex', 'priority', 'fast', 'ultrafast'],
  namespacedTools: true,
  responsesOptionalParameters: true,
  responsesHttpContinuation: true,
  contextGcControl: true,
  conversationModels: true,
  resourceInput: true,
  httpVersions: ['1.1', '2']
});
const workspaceDirectTransferCapability = (): NonNullable<
  NodeCapabilities['workspaceDirectTransfer']
> => ({
  apiVersion: 3,
  transport: true,
  upload: true,
  download: true,
  range: true,
  gitCommitBlob: true,
  maxChunkBytes: 256 * 1024
});
const terminalDirectCapability = (): NonNullable<NodeCapabilities['terminalDirect']> => ({
  apiVersion: 1,
  transport: true
});

export function reportedPlatform(
  platform: NodeJS.Platform = process.platform
): 'windows' | 'linux' | 'macos' {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  return 'linux';
}

function isSupportedPlatform(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' || platform === 'linux' || platform === 'darwin';
}

export function unavailableCapabilities(): NodeCapabilities {
  if (!isSupportedPlatform()) {
    throw new Error('NODE_PLATFORM_UNSUPPORTED');
  }
  return {
    platform: reportedPlatform(),
    architecture: process.arch,
    nodeAppVersion,
    nodeVersion: process.version,
    metadata: {
      osRelease: release(),
      osVersion: version()
    },
    codex: { available: false },
    claudeCode: { available: false },
    openCode: { available: false },
    marAgent: { available: true, version: nodeAppVersion },
    marAgentRuntimeCredentials: runtimeCredentialCapability(),
    promptCompletion: { apiVersion: 1, contextVersion: 3, automaticTriggers: true },
    chatgptLogin: { apiVersion: 1, loopback: true },
    workspaceDirectTransfer: workspaceDirectTransferCapability(),
    sessionAside: { apiVersion: 1 },
    sessionGroups: { apiVersion: 1 },
    terminalDirect: terminalDirectCapability()
  };
}

export function detectCapabilities(
  commands: {
    readonly codex?: string;
    readonly claudeCode?: string;
    readonly openCode?: string;
  } = {}
): NodeCapabilities {
  if (!isSupportedPlatform()) {
    throw new Error('NODE_PLATFORM_UNSUPPORTED');
  }
  const codex = probeCodex(commands.codex);
  const claudeCode = probeClaudeCode(commands.claudeCode);
  const openCode = probeOpenCode(commands.openCode);
  return {
    platform: reportedPlatform(),
    architecture: process.arch,
    nodeAppVersion,
    nodeVersion: process.version,
    metadata: {
      osRelease: release(),
      osVersion: version()
    },
    codex: {
      available: codex.available && codex.compatible,
      ...(codex.version === undefined ? {} : { version: codex.version })
    },
    claudeCode: {
      available: claudeCode.available && claudeCode.compatible,
      ...(claudeCode.version === undefined ? {} : { version: claudeCode.version })
    },
    openCode: {
      available: openCode.available && openCode.compatible,
      ...(openCode.version === undefined ? {} : { version: openCode.version })
    },
    marAgent: { available: true, version: nodeAppVersion },
    marAgentRuntimeCredentials: runtimeCredentialCapability(),
    promptCompletion: { apiVersion: 1, contextVersion: 3, automaticTriggers: true },
    chatgptLogin: { apiVersion: 1, loopback: true },
    workspaceDirectTransfer: workspaceDirectTransferCapability(),
    sessionAside: { apiVersion: 1 },
    sessionGroups: { apiVersion: 1 },
    terminalDirect: terminalDirectCapability()
  };
}

export async function detectCapabilitiesAsync(
  commands: {
    readonly codex?: string;
    readonly claudeCode?: string;
    readonly openCode?: string;
  } = {}
): Promise<NodeCapabilities> {
  if (!isSupportedPlatform()) {
    throw new Error('NODE_PLATFORM_UNSUPPORTED');
  }
  const [codex, claudeCode, openCode, runtimeCommands] = await Promise.all([
    probeCodexAsync(commands.codex),
    probeClaudeCodeAsync(commands.claudeCode),
    probeOpenCodeAsync(commands.openCode),
    detectRuntimeCommands()
  ]);
  return {
    platform: reportedPlatform(),
    architecture: process.arch,
    nodeAppVersion,
    nodeVersion: process.version,
    metadata: {
      osRelease: release(),
      osVersion: version(),
      runtimeCommands
    },
    codex: {
      available: codex.available && codex.compatible,
      ...(codex.version === undefined ? {} : { version: codex.version })
    },
    claudeCode: {
      available: claudeCode.available && claudeCode.compatible,
      ...(claudeCode.version === undefined ? {} : { version: claudeCode.version })
    },
    openCode: {
      available: openCode.available && openCode.compatible,
      ...(openCode.version === undefined ? {} : { version: openCode.version })
    },
    marAgent: { available: true, version: nodeAppVersion },
    marAgentRuntimeCredentials: runtimeCredentialCapability(),
    promptCompletion: { apiVersion: 1, contextVersion: 3, automaticTriggers: true },
    chatgptLogin: { apiVersion: 1, loopback: true },
    workspaceDirectTransfer: workspaceDirectTransferCapability(),
    sessionAside: { apiVersion: 1 },
    sessionGroups: { apiVersion: 1 },
    terminalDirect: terminalDirectCapability()
  };
}
