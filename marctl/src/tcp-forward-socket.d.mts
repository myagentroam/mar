import type { Server, Socket } from 'node:net';
import type { NodeStream } from '@myagentroam/protocol/node-stream';

export function connectForwardSocket(
  endpoint: { host: string; port: number },
  signal: AbortSignal
): Promise<Socket>;
export function listenForwardSocket(
  endpoint: { host: string; port: number },
  lifetime: AbortSignal,
  accept: (socket: Socket) => void,
  setup?: AbortSignal
): Promise<Server>;
export function bridgeForwardSocket(
  socket: Socket,
  stream: NodeStream,
  signal: AbortSignal
): Promise<void>;
