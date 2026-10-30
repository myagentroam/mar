import type { ComposerReference } from '@myagentroam/protocol';

export function composerReferenceKey(reference: ComposerReference): string {
  return reference.type === 'session' ? `session:${reference.sessionId}` : `file:${reference.path}`;
}
