import type WebSocket from 'ws';
import type {
  RemoteDesktopRelayNodeCommand,
  RemoteDesktopRelayNodeEvent
} from '@myagentroam/protocol';
import { RemoteDesktopError } from './desktop-error.js';
import {
  DesktopServiceCore,
  type DesktopAttachment,
  type DesktopAttachmentRegistry
} from './desktop-service-core.js';
import type { DesktopByteStream } from './desktop-byte-stream.js';

type Prepare = Extract<RemoteDesktopRelayNodeCommand, { type: 'desktop.relay.prepare' }>;
export interface RelayDesktopOptions {
  readonly registry?: DesktopAttachmentRegistry;
  readonly nodeId: string;
  readonly nodeGeneration: () => string;
  /** Returns an independently owned socket to the configured Server's relay endpoint. */
  readonly connect: () => WebSocket;
  readonly credential: () => string;
  readonly isCurrent: (command: Prepare) => boolean;
  readonly createAttachment: (
    command: Prepare,
    stream: DesktopByteStream,
    callbacks: { readonly attached: () => void; readonly failed: (code: string) => void }
  ) => DesktopAttachment;
  readonly emit: (event: RemoteDesktopRelayNodeEvent) => boolean;
  readonly now?: () => number;
}

/** Binds one Server-authenticated relay socket to the shared attachment lifecycle. */
export class RelayDesktopService extends DesktopServiceCore {
  constructor(options: RelayDesktopOptions) {
    super({
      path: 'relay',
      ...(options.registry === undefined ? {} : { registry: options.registry }),
      nodeGeneration: options.nodeGeneration,
      ...(options.now === undefined ? {} : { now: options.now }),
      isCurrent: (command) =>
        command.type === 'desktop.relay.prepare' &&
        command.nodeGeneration === options.nodeGeneration() &&
        options.isCurrent(command),
      createAttachment: (command, stream, callbacks) => {
        if (command.type !== 'desktop.relay.prepare')
          throw new RemoteDesktopError('DESKTOP_TRANSPORT_ERROR');
        return options.createAttachment(command, stream, callbacks);
      },
      emit: (event) => options.emit(event as RemoteDesktopRelayNodeEvent),
      transport: (command) => {
        if (command.type !== 'desktop.relay.prepare') return undefined;
        const channel = options.connect();
        return {
          channel,
          valid: () => channel.readyState === 0 || channel.readyState === 1,
          maxMessageBytes: () => 16_384,
          start: () =>
            channel.send(
              JSON.stringify({
                type: 'desktop.relay.node',
                nodeId: options.nodeId,
                nodeGeneration: command.nodeGeneration,
                attachmentId: command.attachmentId,
                ticket: command.ticket,
                credential: options.credential()
              })
            )
        };
      }
    });
  }
}
