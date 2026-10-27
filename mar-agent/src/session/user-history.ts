import type { AgentImageMetadata } from '../runtime/contracts.js';

export interface AgentSessionHistoryImageMetadata extends AgentImageMetadata {
  readable: boolean;
}

export type AgentUserHistoryEntry = {
  kind: 'user';
  recordId?: string;
  sequence: number;
  timestamp: string;
  sessionId: string;
  executionId: string;
  turnId: string;
  text: string;
  clientMessageId?: string;
  inputSource?: 'user' | 'parent_agent';
  images?: readonly AgentSessionHistoryImageMetadata[];
};
