import type { ModelInputMetadata } from '../model/contracts.js';

export interface SessionRecord {
  recordId: string;
  sequence: number;
  timestamp: string;
  sessionId: string;
  executionId?: string;
  turnId?: string;
  type: string;
  payload: unknown;
}

export interface CompactUserInput {
  content: string;
  metadata?: ModelInputMetadata;
}

export interface CompactHistoryMessage extends CompactUserInput {
  role: 'user';
  kind: 'user_input' | 'extension_input' | 'summary';
}
