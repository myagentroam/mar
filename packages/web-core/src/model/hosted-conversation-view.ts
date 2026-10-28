import type { HostedConversationSnapshot } from '@myagentroam/protocol';
import type { ConversationTurn } from './workbench.js';

/** Browser projection; transport snapshots are decoded before reaching this view. */
export type HostedConversationView = Omit<HostedConversationSnapshot, 'turns'> & {
  readonly turns: readonly ConversationTurn[];
};
