import type { SessionRecord } from '../record-contract.js';
export type { SessionRecord, CompactUserInput, CompactHistoryMessage } from '../record-contract.js';
import type { TodoSnapshot } from '../todo.js';
import type { SessionSource } from '../types.js';
import type { ModelImage } from '../../model/image.js';

export interface SessionExecutionState {
  automaticTitlePending: boolean;
  todo: TodoSnapshot;
  contextRecords: SessionRecord[];
}

export interface SessionInputImage extends ModelImage {
  readonly name: string;
}

export interface SessionInputImageMetadata {
  readonly resourceInputVersion: 1;
  readonly name: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly resourceId: string;
  readonly url?: string;
  readonly urlExpiresAt?: number;
}

export interface RestoredSessionInputImage extends ModelImage {}

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
  storage?: { encoding: 1 } | { encoding: 2; generation: string };
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
  version: 1 | 2;
  revision: number;
  sessions: SessionMeta[];
}
