import { nodeEnvelopeSchema, type NodeEnvelope } from '@myagentroam/protocol';
import type { NodeConfig } from '../config.js';
import type { RunnerRegistry } from '../runner/runner-registry.js';

interface NodeControlMessageServiceOptions {
  readonly config: () => NodeConfig | undefined;
  readonly register: (nodeId: string, credential: string, payload?: unknown) => Promise<void>;
  readonly connected: (payload?: unknown) => void;
  readonly usageAck?: (payload: unknown) => void;
  readonly sessionGroupAck?: (payload: unknown) => void;
  readonly bindUsage?: (payload: unknown) => void;
  readonly close: (code: number, reason: string) => void;
  readonly inspectWorkspace: (envelope: NodeEnvelope) => Promise<void>;
  readonly handleNodeRequest: (envelope: NodeEnvelope) => Promise<void>;
  readonly cancelNodeWait?: (requestId: string) => void;
  readonly handleRuntimeCredentialResponse: (envelope: NodeEnvelope) => boolean;
  readonly handleScheduledRunAuthorizeResponse?: (envelope: NodeEnvelope) => boolean;
  readonly handleMailNotificationResponse?: (envelope: NodeEnvelope) => boolean;
  readonly handleMarctlExecutionCredentialResponse?: (envelope: NodeEnvelope) => boolean;
  readonly handleUpgradeCredentialResponse?: (envelope: NodeEnvelope) => boolean;
  readonly handleDirectTransfer?: (envelope: NodeEnvelope) => boolean;
  readonly handleTerminalDirect?: (envelope: NodeEnvelope) => boolean;
  readonly handleDesktopDirect?: (envelope: NodeEnvelope) => boolean;
  readonly handleDesktopRelay?: (envelope: NodeEnvelope) => boolean;
  readonly runners: RunnerRegistry;
  readonly deliverSessionChannelMessage: (envelope: NodeEnvelope) => void;
  readonly completeUncontrolledCancellation: (runId: string) => void;
  readonly send: (type: string, payload: unknown, replyTo?: string) => void;
}

/** Owns parsing and dispatch of the closed Node control-message protocol. */
export class NodeControlMessageService {
  constructor(private readonly options: NodeControlMessageServiceOptions) {}

  handle(raw: string): void {
    let envelope: NodeEnvelope;
    try {
      envelope = nodeEnvelopeSchema.parse(JSON.parse(raw));
    } catch {
      this.options.close(4002, 'MESSAGE_INVALID');
      return;
    }
    this.dispatch(envelope);
  }

  private dispatch(envelope: NodeEnvelope): void {
    if (envelope.type === 'registered') {
      this.register(envelope);
      return;
    }
    if (envelope.type === 'authenticated') {
      this.options.connected(envelope.payload);
      return;
    }
    if (envelope.type === 'workspace.inspect') {
      void this.options.inspectWorkspace(envelope);
      return;
    }
    if (envelope.type === 'node.request') {
      void this.options.handleNodeRequest(envelope);
      return;
    }
    if (envelope.type === 'node.request.cancel') {
      const payload = envelope.payload as { requestId?: unknown } | null;
      if (typeof payload?.requestId === 'string') this.options.cancelNodeWait?.(payload.requestId);
      return;
    }
    if (this.options.handleRuntimeCredentialResponse(envelope)) return;
    if (this.options.handleScheduledRunAuthorizeResponse?.(envelope) === true) return;
    if (this.options.handleMailNotificationResponse?.(envelope) === true) return;
    if (this.options.handleMarctlExecutionCredentialResponse?.(envelope) === true) return;
    if (this.options.handleUpgradeCredentialResponse?.(envelope) === true) return;
    if (
      envelope.type.startsWith('direct.') &&
      this.options.handleDirectTransfer?.(envelope) === true
    )
      return;
    if (
      envelope.type.startsWith('terminal.direct.') &&
      this.options.handleTerminalDirect?.(envelope) === true
    )
      return;
    if (envelope.type === 'desktop.ready') {
      if (this.options.handleDesktopDirect?.(envelope) !== true)
        this.options.handleDesktopRelay?.(envelope);
      return;
    }
    if (
      envelope.type.startsWith('desktop.direct.') &&
      this.options.handleDesktopDirect?.(envelope) === true
    )
      return;
    if (
      envelope.type.startsWith('desktop.relay.') &&
      this.options.handleDesktopRelay?.(envelope) === true
    )
      return;
    if (envelope.type === 'usage.ack') {
      this.options.usageAck?.(envelope.payload);
      return;
    }
    if (envelope.type === 'ack') return;
    if (envelope.type === 'session.group.ack') {
      this.options.sessionGroupAck?.(envelope.payload);
      return;
    }
    if (envelope.type === 'run.approval.decision') {
      this.decideApproval(envelope);
      return;
    }
    if (envelope.type === 'run.start') {
      this.options.send('ack', { type: envelope.type }, envelope.id);
      try {
        this.options.bindUsage?.(envelope.payload);
        this.options.runners.startManagedRun(envelope);
      } catch (error) {
        // A delayed internal start may arrive after the terminal projection was removed.
        if (!(error instanceof Error) || error.message !== 'RUN_TERMINAL') throw error;
      }
      return;
    }
    if (envelope.type === 'session.channel.message') {
      this.options.deliverSessionChannelMessage(envelope);
      return;
    }
    if (envelope.type === 'run.cancel' || envelope.type === 'run.interrupt') {
      this.cancelRun(envelope);
      return;
    }
    if (envelope.type !== 'error')
      this.options.send('error', { code: 'MESSAGE_TYPE_UNKNOWN' }, envelope.id);
  }

  private register(envelope: NodeEnvelope): void {
    const payload = envelope.payload as { nodeId?: unknown; credential?: unknown };
    if (
      typeof payload.nodeId !== 'string' ||
      typeof payload.credential !== 'string' ||
      this.options.config() === undefined
    ) {
      this.options.close(4002, 'MESSAGE_INVALID');
      return;
    }
    void this.options.register(payload.nodeId, payload.credential, envelope.payload);
  }

  private decideApproval(envelope: NodeEnvelope): void {
    const payload = envelope.payload as {
      runId?: unknown;
      approvalId?: unknown;
      decision?: unknown;
    };
    if (
      typeof payload.runId !== 'string' ||
      typeof payload.approvalId !== 'string' ||
      (payload.decision !== 'APPROVED' && payload.decision !== 'REJECTED')
    ) {
      this.options.send('error', { code: 'MESSAGE_INVALID' }, envelope.id);
      return;
    }
    this.options.runners.decideApproval({
      runId: payload.runId,
      approvalId: payload.approvalId,
      decision: payload.decision
    });
    this.options.send('ack', { type: envelope.type }, envelope.id);
  }

  private cancelRun(envelope: NodeEnvelope): void {
    const payload = envelope.payload as { runId?: unknown };
    if (typeof payload.runId === 'string') {
      const handled = this.options.runners.cancelManagedRun(
        payload.runId,
        envelope.type === 'run.cancel' ? 'CANCEL' : 'INTERRUPT'
      );
      if (!handled) this.options.completeUncontrolledCancellation(payload.runId);
    }
    this.options.send('ack', { type: envelope.type }, envelope.id);
  }
}
