import type { ModelRequest } from '../../../src/model/contracts.js';

export function latestUserText(request: ModelRequest): string | undefined {
  const latest = request.messages.findLast(
    (message) => message.contextualBlock?.authority !== 'instruction'
  );
  return latest?.role === 'user' && latest.contextKind === undefined ? latest.content : undefined;
}

/** Read the active instruction projection rather than assuming all policy is in system. */
export function effectiveInstructions(request: ModelRequest): string {
  const active = new Map<string, string>();
  for (const message of request.messages) {
    const block = message.contextualBlock;
    if (block?.authority !== 'instruction') continue;
    if (block.operation === 'remove') active.delete(block.id);
    else active.set(block.id, message.content);
  }
  return [request.system, ...active.values()].join('\n\n');
}

export function baseMessages(request: ModelRequest) {
  return request.messages
    .filter((message) => message.contextualBlock?.authority !== 'instruction')
    .map(({ contextualBlock: _block, ...message }) => message);
}
