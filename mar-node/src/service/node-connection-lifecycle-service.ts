import type { NodeCapabilities } from '@myagentroam/protocol';
import { saveNodeConfig, type NodeConfig } from '../config.js';
import type { NodeMetrics } from '../operational.js';
import type { NodeControlChannel } from './node-control-channel.js';
import type { NodeTerminalChannel } from './node-terminal-channel.js';

interface NodeConnectionLifecycleServiceOptions {
  readonly config: () => NodeConfig | undefined;
  readonly setConfig: (config: NodeConfig) => void;
  readonly configPath: string | undefined;
  readonly capabilities: () => NodeCapabilities;
  readonly detectCapabilities: () => NodeCapabilities | Promise<NodeCapabilities>;
  readonly capabilitiesProvided: boolean;
  readonly stopped: () => boolean;
  readonly setCapabilities: (capabilities: NodeCapabilities) => void;
  readonly control: NodeControlChannel;
  readonly terminal: NodeTerminalChannel;
  readonly metrics: NodeMetrics;
  readonly heartbeatMs: number;
  readonly refreshMs: number;
  readonly onRegistered?: () => Promise<void>;
  readonly onConnected?: () => void;
}

/** Owns registration completion, heartbeat and background capability refresh timers. */
export class NodeConnectionLifecycleService {
  private heartbeat: NodeJS.Timeout | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;
  private refreshing = false;

  constructor(private readonly options: NodeConnectionLifecycleServiceOptions) {}

  start(): void {
    this.startCapabilityRefresh();
  }

  startCapabilityRefresh(): void {
    if (this.refreshTimer !== undefined) clearInterval(this.refreshTimer);
    if (!this.options.capabilitiesProvided) void this.refreshCapabilities();
    this.refreshTimer = setInterval(() => void this.refreshCapabilities(), this.options.refreshMs);
  }

  stop(): void {
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat);
    if (this.refreshTimer !== undefined) clearInterval(this.refreshTimer);
    this.heartbeat = undefined;
    this.refreshTimer = undefined;
  }

  async register(nodeId: string, credential: string): Promise<void> {
    const config = this.options.config();
    if (config === undefined) return;
    const registered: NodeConfig = {
      serverUrl: config.serverUrl,
      allowedRoots: config.allowedRoots,
      ...(config.dataDirectory === undefined ? {} : { dataDirectory: config.dataDirectory }),
      ...(config.conversationHosting === undefined
        ? {}
        : { conversationHosting: config.conversationHosting }),
      ...(config.directTransfer === undefined ? {} : { directTransfer: config.directTransfer }),
      ...(config.computerUse === undefined ? {} : { computerUse: config.computerUse }),
      nodeId,
      credential
    };
    this.options.setConfig(registered);
    await saveNodeConfig(registered, this.options.configPath);
    await this.options.onRegistered?.();
    this.connected();
  }

  connected(): void {
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat);
    this.options.control.send('capabilities', this.options.capabilities());
    this.options.terminal.connect();
    this.options.control.send('heartbeat', {});
    this.options.onConnected?.();
    this.options.metrics.heartbeatSent();
    this.heartbeat = setInterval(() => {
      this.options.metrics.heartbeatSent();
      this.options.control.send('heartbeat', {});
    }, this.options.heartbeatMs);
  }

  async refreshCapabilities(): Promise<void> {
    if (this.options.stopped() || this.refreshing) return;
    this.refreshing = true;
    try {
      let next: NodeCapabilities;
      try {
        next = await this.options.detectCapabilities();
      } catch {
        next = {
          ...this.options.capabilities(),
          codex: { available: false },
          claudeCode: { available: false },
          openCode: { available: false }
        };
      }
      if (
        this.options.stopped() ||
        JSON.stringify(next) === JSON.stringify(this.options.capabilities())
      )
        return;
      this.options.setCapabilities(next);
      this.options.control.send('capabilities', next);
    } finally {
      this.refreshing = false;
    }
  }
}
