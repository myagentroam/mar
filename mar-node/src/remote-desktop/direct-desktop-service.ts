import type { RTCPeerConnection } from 'node-datachannel/polyfill';
import type {
  RemoteDesktopDirectNodeCommand,
  RemoteDesktopDirectNodeEvent
} from '@myagentroam/protocol';
import { RemoteDesktopError } from './desktop-error.js';
import {
  DesktopServiceCore,
  type DesktopAttachment,
  type DesktopAttachmentRegistry
} from './desktop-service-core.js';
import type { DesktopByteStream } from './desktop-byte-stream.js';

type Prepare = Extract<RemoteDesktopDirectNodeCommand, { type: 'desktop.direct.prepare' }>;
export interface DirectDesktopOptions {
  readonly registry?: DesktopAttachmentRegistry;
  readonly nodeGeneration: () => string;
  /** Returns a peer only when the Node, page, connection and both fingerprints still match. */
  readonly peer: (command: Prepare) => RTCPeerConnection | undefined;
  readonly isCurrent: (command: Prepare) => boolean;
  readonly createAttachment: (
    command: Prepare,
    stream: DesktopByteStream,
    callbacks: { readonly attached: () => void; readonly failed: (code: string) => void }
  ) => DesktopAttachment;
  readonly emit: (event: RemoteDesktopDirectNodeEvent) => boolean;
  readonly now?: () => number;
}

/** Binds reliable Node-created RTC channels to the shared attachment lifecycle. */
export class DirectDesktopService extends DesktopServiceCore {
  constructor(options: DirectDesktopOptions) {
    super({
      path: 'direct',
      ...(options.registry === undefined ? {} : { registry: options.registry }),
      nodeGeneration: options.nodeGeneration,
      ...(options.now === undefined ? {} : { now: options.now }),
      isCurrent: (command) =>
        command.type === 'desktop.direct.prepare' && options.isCurrent(command),
      createAttachment: (command, stream, callbacks) => {
        if (command.type !== 'desktop.direct.prepare')
          throw new RemoteDesktopError('DESKTOP_TRANSPORT_ERROR');
        return options.createAttachment(command, stream, callbacks);
      },
      emit: (event) => options.emit(event as RemoteDesktopDirectNodeEvent),
      transport: (command) => {
        if (command.type !== 'desktop.direct.prepare') return undefined;
        let peer: RTCPeerConnection | undefined;
        try {
          peer = options.peer(command);
        } catch {
          return undefined;
        }
        if (!peer) return undefined;
        const channel = peer.createDataChannel(`mar-desktop-${command.attachmentId}`, {
          ordered: true
        }) as unknown as RTCDataChannel;
        return {
          channel,
          valid: () => options.peer(command) === peer,
          maxMessageBytes: () => {
            const negotiated = peer.sctp?.maxMessageSize;
            if (negotiated === undefined || !Number.isFinite(negotiated) || negotiated < 0)
              throw new RemoteDesktopError('DESKTOP_TRANSPORT_ERROR');
            return negotiated === 0 ? 16_384 : Math.min(16_384, negotiated);
          }
        };
      }
    });
  }
}
