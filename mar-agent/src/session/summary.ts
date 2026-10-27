import type { SessionSource } from './types.js';

export interface AgentSessionSummary {
  id: string;
  title: string;
  /** First non-empty user input, whitespace-normalized and bounded to 160 characters. */
  firstUserMessagePreview?: string;
  workspace: string;
  createdAt: string;
  lastActivityAt: string;
  source: SessionSource;
  modelId?: string;
  modelName?: string;
  reasoningEffort?: string;
}

export interface AgentSessionPage {
  sessions: AgentSessionSummary[];
  nextCursor?: string;
}
