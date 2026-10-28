import {
  computerUseDisableInputSchema,
  computerUseEnableInputSchema,
  computerUseEnableResultSchema,
  type ComputerUseCapability,
  type ComputerUseEnableResult
} from '@myagentroam/protocol';
import { computerUseRuntimeExecutable, saveNodeConfig, type NodeConfig } from '../config.js';
import type {
  ComputerUseExecutionProvider,
  ComputerUseSupport
} from '../runner/mar-agent/computer-use.js';
import type { NodeOperationHandler } from '../application/node-operation-contracts.js';
import { nodeOperationData } from '../connection/node-operation-data.js';

interface ComputerUseEnablementServiceOptions {
  readonly config: () => NodeConfig | undefined;
  readonly setConfig: (config: NodeConfig) => void;
  readonly configPath: string | undefined;
  readonly provider: ComputerUseExecutionProvider;
  readonly prepareRuntime: () => Promise<string>;
  readonly publish: (capability: ComputerUseCapability) => void;
  readonly now?: () => number;
}

/** Persists Computer Use authorization and owns its asynchronous capability probe. */
export class ComputerUseEnablementService {
  readonly #now: () => number;
  #capability: ComputerUseCapability;
  #probeGeneration = 0;

  constructor(private readonly options: ComputerUseEnablementServiceOptions) {
    this.#now = options.now ?? Date.now;
    this.#capability = this.#disabled();
  }

  capability(): ComputerUseCapability {
    return this.#capability;
  }

  operations(): Readonly<Record<string, NodeOperationHandler>> {
    return {
      'computer.use.enable': (data) => this.enable(data),
      'computer.use.disable': (data) => this.disable(data)
    };
  }

  initialize(): void {
    if (this.options.config()?.computerUse?.enabled !== true) {
      this.#set(this.#disabled(), false);
      return;
    }
    this.#beginProbe();
  }

  private async enable(data: unknown): Promise<ComputerUseEnableResult> {
    const parsed = computerUseEnableInputSchema.safeParse(nodeOperationData(data));
    if (!parsed.success) throw new Error('COMPUTER_USE_ENABLE_INPUT_INVALID');
    const current = this.options.config();
    if (current === undefined) throw new Error('NODE_CONFIG_UNAVAILABLE');
    if (current.computerUse?.enabled !== true) {
      const next: NodeConfig = {
        ...current,
        computerUse: {
          ...current.computerUse,
          enabled: true
        }
      };
      await saveNodeConfig(next, this.options.configPath);
      this.options.setConfig(next);
    }
    this.#beginProbe();
    return computerUseEnableResultSchema.parse({ capability: this.#capability });
  }

  private async disable(data: unknown): Promise<ComputerUseEnableResult> {
    const parsed = computerUseDisableInputSchema.safeParse(nodeOperationData(data));
    if (!parsed.success) throw new Error('COMPUTER_USE_DISABLE_INPUT_INVALID');
    const current = this.options.config();
    if (current === undefined) throw new Error('NODE_CONFIG_UNAVAILABLE');
    this.#probeGeneration += 1;
    if (current.computerUse?.enabled === true) {
      const next: NodeConfig = {
        ...current,
        computerUse: {
          ...current.computerUse,
          enabled: false
        }
      };
      this.options.setConfig(next);
      try {
        await this.options.provider.reset();
        await saveNodeConfig(next, this.options.configPath);
      } catch (error) {
        this.options.setConfig(current);
        this.initialize();
        throw error;
      }
    } else {
      await this.options.provider.reset();
    }
    this.#set(this.#disabled());
    return computerUseEnableResultSchema.parse({ capability: this.#capability });
  }

  #beginProbe(): void {
    const config = this.options.config();
    if (config === undefined || config.computerUse?.enabled !== true) {
      this.#set(this.#disabled());
      return;
    }
    const runtimeExecutable = computerUseRuntimeExecutable(config, this.options.configPath);
    if (runtimeExecutable === undefined) {
      this.#set(this.#unavailable('COMPUTER_RUNTIME_MISSING'));
      return;
    }
    const generation = ++this.#probeGeneration;
    this.#set({
      apiVersion: 1,
      enabled: true,
      state: 'INITIALIZING',
      backend: 'PYAUTOGUI',
      supportsScreenshot: false,
      supportsInput: false,
      supportsUnicodePaste: false,
      supportsPrimaryDisplay: false,
      measuredAt: this.#now()
    });
    void this.options.provider
      .reset()
      .then(() => this.options.prepareRuntime())
      .then(() => this.options.provider.support())
      .then((support) => {
        if (generation !== this.#probeGeneration) return;
        this.#set(this.#fromSupport(support));
      })
      .catch((error: unknown) => {
        if (generation !== this.#probeGeneration) return;
        this.#set(
          this.#unavailable(
            error instanceof Error && /^[A-Z][A-Z0-9_]{0,79}$/u.test(error.message)
              ? error.message
              : 'COMPUTER_PROBE_FAILED'
          )
        );
      });
  }

  #fromSupport(support: ComputerUseSupport): ComputerUseCapability {
    if (!support.available)
      return this.#unavailable(support.reasonCode ?? 'COMPUTER_UNAVAILABLE', support);
    return {
      apiVersion: 1,
      enabled: true,
      state: 'AVAILABLE',
      backend: 'PYAUTOGUI',
      supportsScreenshot: support.supportsScreenshot,
      supportsInput: support.supportsInput,
      supportsUnicodePaste: support.supportsUnicodePaste,
      supportsPrimaryDisplay: support.supportsPrimaryDisplay,
      measuredAt: this.#now()
    };
  }

  #disabled(): ComputerUseCapability {
    return {
      apiVersion: 1,
      enabled: false,
      state: 'DISABLED',
      backend: 'PYAUTOGUI',
      supportsScreenshot: false,
      supportsInput: false,
      supportsUnicodePaste: false,
      supportsPrimaryDisplay: false,
      measuredAt: this.#now()
    };
  }

  #unavailable(
    reasonCode: string,
    support?: Pick<
      ComputerUseSupport,
      'supportsScreenshot' | 'supportsInput' | 'supportsUnicodePaste' | 'supportsPrimaryDisplay'
    >
  ): ComputerUseCapability {
    return {
      apiVersion: 1,
      enabled: true,
      state: 'UNAVAILABLE',
      backend: 'PYAUTOGUI',
      supportsScreenshot: support?.supportsScreenshot ?? false,
      supportsInput: support?.supportsInput ?? false,
      supportsUnicodePaste: support?.supportsUnicodePaste ?? false,
      supportsPrimaryDisplay: support?.supportsPrimaryDisplay ?? false,
      reasonCode,
      measuredAt: this.#now()
    };
  }

  #set(capability: ComputerUseCapability, publish = true): void {
    this.#capability = computerUseEnableResultSchema.parse({ capability }).capability;
    if (publish) this.options.publish(this.#capability);
  }
}
