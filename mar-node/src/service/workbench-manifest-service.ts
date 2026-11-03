import type { NodeCapabilities } from '@myagentroam/protocol';
import type { TerminalManager } from '../terminal.js';
import type { RunnerService } from './runner-service.js';

function revisionFor(capabilities: NodeCapabilities): number {
  const source = JSON.stringify({
    platform: capabilities.platform,
    architecture: capabilities.architecture,
    codex: capabilities.codex,
    claudeCode: capabilities.claudeCode,
    openCode: capabilities.openCode
  });
  let hash = 2_166_136_261;
  for (const character of source) hash = Math.imul(hash ^ character.charCodeAt(0), 16_777_619);
  return hash >>> 0;
}

interface WorkbenchManifestServiceOptions {
  readonly capabilities: () => NodeCapabilities;
  readonly nodeGeneration: () => string;
  readonly runners: RunnerService;
  readonly terminals: TerminalManager;
}

/** Builds the capability-driven Workbench contract exposed by this Node. */
export class WorkbenchManifestService {
  constructor(private readonly options: WorkbenchManifestServiceOptions) {}

  async read() {
    const capabilities = this.options.capabilities();
    return {
      manifestVersion: 1 as const,
      revision: revisionFor(capabilities),
      observedAt: Date.now(),
      nodeGeneration: this.options.nodeGeneration(),
      platform: capabilities.platform,
      architecture: capabilities.architecture,
      conversation: {
        available: true,
        reasonCode: null,
        itemVersions: [2],
        supportsSessionCursor: true,
        supportsHistoryPaging: true,
        supportsItemFinalSnapshots: true,
        maxPageSize: 500
      },
      runners: await this.options.runners.profiles(),
      files: {
        available: true,
        reasonCode: null,
        supportsList: true,
        supportsReadRange: true,
        supportsSearch: true,
        maxDirectoryPageSize: 200,
        maxReadBytes: 512 * 1024,
        maxSearchResults: 200
      },
      directTransfer: capabilities.workspaceDirectTransfer,
      terminalDirect: capabilities.terminalDirect,
      sessionAside: capabilities.sessionAside,
      sessionGroups: capabilities.sessionGroups,
      git: {
        available: true,
        reasonCode: null,
        supportsCurrentChanges: true,
        supportsTurnChanges: true,
        supportsHistory: true,
        maxDiffBytes: 512 * 1024
      },
      terminal: {
        available: true,
        reasonCode: null,
        supportsPty: capabilities.platform === 'linux' || capabilities.platform === 'macos',
        supportsConPty: capabilities.platform === 'windows',
        supportsReplay: true,
        supportsReadonlyAttach: true,
        supportsTakeover: false,
        ...this.options.terminals.limits(),
        profiles: this.options.terminals.availableProfiles()
      }
    };
  }
}
