import type { ModelInputMetadata } from '../../model/contracts.js';
import type { TodoSnapshot } from '../../tools/agent/todo.js';
import type { SessionSource } from '../types.js';

export interface SessionRecord {
  schemaVersion: 1;
  recordId: string;
  sequence: number;
  timestamp: string;
  sessionId: string;
  executionId?: string;
  turnId?: string;
  type: string;
  payload: unknown;
}

export interface SessionExecutionState {
  automaticTitlePending: boolean;
  todo: TodoSnapshot;
  contextRecords: SessionRecord[];
}

export interface CompactUserInput {
  content: string;
  metadata?: ModelInputMetadata;
}

export interface CompactHistoryMessage extends CompactUserInput {
  role: 'user';
  kind: 'user_input' | 'extension_input' | 'summary';
}

export interface SessionInputImage {
  readonly name: string;
  readonly mimeType: string;
  readonly dataBase64: string;
}

export interface SessionInputImageMetadata {
  readonly name: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly fileName: string;
  readonly sha256: string;
}

export interface RestoredSessionInputImage {
  readonly mimeType: string;
  readonly dataBase64: string;
}

export interface SessionInputImageData extends SessionInputImageMetadata {
  readonly dataBase64: string;
}

export interface SessionMeta {
  id: string;
  title: string;
  workspace: string;
  createdAt: string;
  lastActivityAt: string;
  source?: SessionSource;
  nextSequence: number;
  automaticTitlePending?: boolean;
  storageTransactionId?: string;
  resume?: {
    version: 1;
    userTurns?: number;
    compactSequence?: number;
    todoSequence?: number;
    todoRevision: number;
    executionModelIndexed?: true;
    firstUserMessageIndexed?: true;
    firstUserMessagePreview?: string;
    modelId?: string;
    modelName?: string;
    reasoningEffort?: string;
  };
  segments?: Array<{
    number: number;
    firstSequence: number;
    lastSequence: number;
    bytes: number;
  }>;
}

export interface SessionIndex {
  version: 1;
  revision: number;
  sessions: SessionMeta[];
}
